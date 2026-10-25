import { createHash, createHmac, randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import type { Logger, ResolvedYuanbaoAccount, YuanbaoMsgBodyElement } from './types.js';

/**
 * Outbound media: upload a local file to the Yuanbao resource store (COS) and
 * build the corresponding TIM message body.
 *
 * Mirrors the reference `yuanbao-openclaw-plugin`: ask the platform for a
 * temporary COS upload credential, PUT the bytes with an HMAC-SHA1 signed
 * request, then reference the resulting object in the message body. Images
 * become TIMImageElem, everything else TIMFileElem.
 */

const UPLOAD_INFO_PATH = '/api/resource/genUploadInfo';
const HTTP_AUTH_RETRY_MAX = 1;

/**
 * Temporary COS upload credential returned by `/api/resource/genUploadInfo`.
 *
 * Field names mirror the platform response exactly (verified against a live
 * call): note `location` is the COS **object key**, `region` is the COS region,
 * and the resource id is `resourceID` with a capital D. Treating `location` as
 * a region produces a host like `bucket.cos.multimedia_70.myqcloud.com`, which
 * the platform rejects with HTTP 403.
 */
export type CosUploadConfig = {
  bucketName: string;
  /** COS region, e.g. `ap-guangzhou`. Used to build the request host. */
  region: string;
  /** COS object key, e.g. `/multimedia_70/<hash>/<timestamp>_<hash>.png`. */
  location: string;
  encryptTmpSecretId: string;
  encryptTmpSecretKey: string;
  encryptToken?: string;
  startTime: number;
  expiredTime: number;
  /** Public URL to reference in the message body. */
  resourceUrl?: string;
  /** Platform resource id; referenced as `resourceID` in the response. */
  resourceID?: string;
  [key: string]: unknown;
};

/** Sign-token payload used for the HTTP auth headers. */
export type HttpAuth = {
  botId: string;
  token: string;
  source: string;
};

export type UploadDeps = {
  account: ResolvedYuanbaoAccount;
  logger: Logger;
  /** Resolve (and refresh) the HTTP auth headers for this account. */
  resolveAuth: (account: ResolvedYuanbaoAccount) => Promise<HttpAuth>;
};

function hmacSha1(key: string, message: string): string {
  return createHmac('sha1', key).update(message).digest('hex');
}

function sha1Hex(data: string): string {
  return createHash('sha1').update(data).digest('hex');
}

/** Build the COS PUT Object Authorization header. */
export function signCosRequest(params: {
  secretId: string;
  secretKey: string;
  method: string;
  pathname: string;
  headers: Record<string, string>;
  startTime: number;
  expiredTime: number;
}): string {
  const { secretId, secretKey, method, pathname, startTime, expiredTime } = params;
  const keyTime = `${startTime};${expiredTime}`;
  const signKey = hmacSha1(secretKey, keyTime);

  const sortedHeaderKeys = Object.keys(params.headers).map(k => k.toLowerCase()).sort();
  const headerList = sortedHeaderKeys.join(';');
  const httpHeaders = sortedHeaderKeys
    .map(k => {
      const original = Object.keys(params.headers).find(h => h.toLowerCase() === k);
      return `${k}=${encodeURIComponent(params.headers[original ?? k] ?? '')}`;
    })
    .join('&');

  const httpString = `${method.toLowerCase()}\n${pathname}\n\n${httpHeaders}\n`;
  const stringToSign = `sha1\n${keyTime}\n${sha1Hex(httpString)}\n`;
  const signature = hmacSha1(signKey, stringToSign);

  return [
    'q-sign-algorithm=sha1',
    `q-ak=${secretId}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    `q-header-list=${headerList}`,
    'q-url-param-list=',
    `q-signature=${signature}`,
  ].join('&');
}

/** Ask the platform for a temporary COS upload credential. */
async function requestUploadInfo(
  deps: UploadDeps,
  fileName: string,
  fileId: string,
): Promise<CosUploadConfig> {
  const { account, logger, resolveAuth } = deps;
  const url = `https://${account.apiDomain}${UPLOAD_INFO_PATH}`;

  for (let attempt = 0; attempt <= HTTP_AUTH_RETRY_MAX; attempt += 1) {
    const auth = await resolveAuth(account);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ID': auth.botId,
        'X-Token': auth.token,
        'X-Source': auth.source || 'web',
        'X-AppVersion': 'dsh-yuanbao',
        'X-OperationSystem': process.platform,
      },
      body: JSON.stringify({ fileName, fileId, docFrom: 'localDoc', docOpenId: '' }),
    });

    if (response.status === 401 && attempt < HTTP_AUTH_RETRY_MAX) {
      logger.warn(`upload info 401, refreshing token and retrying: attempt=${attempt + 1}`);
      continue;
    }
    if (!response.ok) {
      throw new Error(`genUploadInfo HTTP ${response.status} ${response.statusText}`);
    }
    const payload = (await response.json()) as { data?: CosUploadConfig } & CosUploadConfig;
    const config = payload.data ?? payload;
    // `region` and `location` are both required: the host is built from region
    // and the object key from location. Accepting a config missing region is
    // what produced the earlier HTTP 403 against a bogus host.
    const missing = (['bucketName', 'region', 'location', 'encryptTmpSecretId', 'encryptTmpSecretKey'] as const)
      .filter(field => typeof config?.[field] !== 'string' || !config[field]);
    if (missing.length > 0) {
      throw new Error(`genUploadInfo incomplete config: missing ${missing.join(', ')}; got ${JSON.stringify(payload).slice(0, 200)}`);
    }
    return config;
  }

  throw new Error('genUploadInfo failed: max retries exceeded');
}

/** PUT one object into COS using the temporary credential. */
/**
 * PUT one object into COS using the temporary credential.
 *
 * The host is built from `config.region` (never `location`, which is the object
 * key). Images also carry a Pic-Operations rule so COS normalizes them to JPEG,
 * matching the reference implementation.
 */
async function putObject(
  config: CosUploadConfig,
  key: string,
  body: Uint8Array,
  fileName: string,
  mediaType: string,
  logger: Logger,
): Promise<void> {
  const pathname = key.startsWith('/') ? key : `/${key}`;
  if (!config.region) {
    throw new Error('COS upload config missing region');
  }
  const host = `${config.bucketName}.cos.${config.region}.myqcloud.com`;

  const signHeaders: Record<string, string> = {
    host,
    'content-length': String(body.byteLength),
  };
  const extraHeaders: Record<string, string> = {
    'Content-Type': mediaType,
  };
  if (mediaType.startsWith('image/')) {
    extraHeaders['Pic-Operations'] = JSON.stringify({
      is_pic_info: 1,
      rules: [{ fileid: pathname, rule: 'imageMogr2/format/jpg' }],
    });
  }
  if (config.encryptToken) {
    signHeaders['x-cos-security-token'] = config.encryptToken;
    extraHeaders['x-cos-security-token'] = config.encryptToken;
  }

  const authorization = signCosRequest({
    secretId: config.encryptTmpSecretId,
    secretKey: config.encryptTmpSecretKey,
    method: 'PUT',
    pathname,
    headers: signHeaders,
    startTime: config.startTime,
    expiredTime: config.expiredTime,
  });

  // fetch sets Host/Content-Length itself; passing them trips undici.
  const response = await fetch(`https://${host}${pathname}`, {
    method: 'PUT',
    headers: { ...extraHeaders, Authorization: authorization },
    body: body as unknown as BodyInit,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`COS PUT failed: HTTP ${response.status} ${response.statusText}${detail ? `; ${detail.slice(0, 200)}` : ''}`);
  }
  logger.info(`cos upload ok: key=${pathname}; bytes=${body.byteLength}; type=${mediaType}; file=${fileName}`);
}

/** Guess a MIME type from a filename. */
export function guessMimeType(name: string): string {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  const table: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.zip': 'application/zip',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
  };
  return table[ext] ?? 'application/octet-stream';
}

export function isImageFile(name: string): boolean {
  return guessMimeType(name).startsWith('image/');
}

/** Read intrinsic PNG/JPEG dimensions; 0 when unknown. */
export function imageDimensions(data: Uint8Array): { width: number; height: number } {
  // PNG: IHDR width/height are big-endian at offsets 16 and 20.
  if (data.length > 24 && data[0] === 0x89 && data[1] === 0x50) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  // JPEG: walk the segment markers to the SOF frame.
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = data[offset + 1] ?? 0;
      const size = ((data[offset + 2] ?? 0) << 8) | (data[offset + 3] ?? 0);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = ((data[offset + 5] ?? 0) << 8) | (data[offset + 6] ?? 0);
        const width = ((data[offset + 7] ?? 0) << 8) | (data[offset + 8] ?? 0);
        return { width, height };
      }
      offset += 2 + size;
    }
  }
  return { width: 0, height: 0 };
}

/** Build a TIMImageElem body referencing an uploaded object. */
export function buildImageMsgBody(params: {
  url: string;
  filename?: string;
  size?: number;
  uuid?: string;
  imageInfo?: { width: number; height: number };
}): YuanbaoMsgBodyElement[] {
  return [
    {
      msg_type: 'TIMImageElem',
      msg_content: {
        uuid: params.uuid ?? params.filename ?? 'image',
        image_format: 255,
        image_info_array: [
          {
            type: 1,
            size: params.size ?? 0,
            width: params.imageInfo?.width ?? 0,
            height: params.imageInfo?.height ?? 0,
            url: params.url,
          },
        ],
      },
    },
  ];
}

/** Build a TIMFileElem body referencing an uploaded object. */
export function buildFileMsgBody(params: {
  url: string;
  filename: string;
  size?: number;
  uuid?: string;
}): YuanbaoMsgBodyElement[] {
  return [
    {
      msg_type: 'TIMFileElem',
      msg_content: {
        url: params.url,
        file_name: params.filename,
        file_size: params.size ?? 0,
        ...(params.uuid ? { uuid: params.uuid } : {}),
      },
    },
  ];
}

/** Resolve the public URL of an uploaded object. */
function uploadedUrl(config: CosUploadConfig, key: string): string {
  const host = `${config.bucketName}.cos.${config.region}.myqcloud.com`;
  const pathname = key.startsWith('/') ? key : `/${key}`;
  return `https://${host}${pathname}`;
}

/**
 * Upload a local file and return a ready-to-send message body.
 * Throws on failure so the caller can fall back to sending a text message.
 */
export async function buildMediaMessageBody(params: {
  deps: UploadDeps;
  filePath: string;
  data: Uint8Array;
  displayName?: string;
}): Promise<YuanbaoMsgBodyElement[]> {
  const { deps, filePath, data } = params;
  const name = params.displayName ?? basename(filePath);
  const mediaType = guessMimeType(name);
  // The reference implementation sends a random 16-byte hex file id.
  const fileId = randomBytes(16).toString('hex');

  const config = await requestUploadInfo(deps, name, fileId);

  // `location` is the object key; the platform assigns it, so it must not be
  // replaced with the resource id (that is a separate handle).
  const key = typeof config.location === 'string' && config.location ? config.location : fileId;
  await putObject(config, key, data, name, mediaType, deps.logger);

  // Prefer the platform-provided public URL; fall back to the COS object URL.
  const url = (typeof config.resourceUrl === 'string' && config.resourceUrl)
    || uploadedUrl(config, key);

  // A content digest is a stable identity for the same bytes, matching the
  // reference implementation's md5-based uuid.
  const uuid = createHash('md5').update(data).digest('hex');

  if (mediaType.startsWith('image/')) {
    const imageInfo = imageDimensions(data);
    deps.logger.info(`media message built: image=${name}; ${imageInfo.width}x${imageInfo.height}; bytes=${data.byteLength}; url=${url}`);
    return buildImageMsgBody({ url, filename: name, size: data.byteLength, uuid, imageInfo });
  }
  deps.logger.info(`media message built: file=${name}; bytes=${data.byteLength}; url=${url}`);
  return buildFileMsgBody({ url, filename: name, size: data.byteLength, uuid });
}
