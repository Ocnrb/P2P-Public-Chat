// config.js

export const CHAT_STREAM_ID = '0xd5a8024414f59cf0c453c35fc3655a31251645f6/app1';
export const METRICS_STREAM_ID = '0xd5a8024414f59cf0c453c35fc3655a31251645f6/app2';
export const IMAGE_STREAM_ID = '0xd5a8024414f59cf0c453c35fc3655a31251645f6/app3';
export const FILE_STREAM_ID = '0xd5a8024414f59cf0c453c35fc3655a31251645f6/app4';
export const VIDEO_STREAM_ID = '0xd5a8024414f59cf0c453c35fc3655a31251645f6/app5';
export const AUDIO_STREAM_ID = '0xd5a8024414f59cf0c453c35fc3655a31251645f6/app6';
export const REACTION_STREAM_ID = '0xd5a8024414f59cf0c453c35fc3655a31251645f6/app7';
export const TYPING_STREAM_ID = '0xd5a8024414f59cf0c453c35fc3655a31251645f6/app8';
export const FILE_META_STREAM_ID = '0xd5a8024414f59cf0c453c35fc3655a31251645f6/app9';
export const PFS_CONTROL_STREAM_ID = '0xd5a8024414f59cf0c453c35fc3655a31251645f6/app10';
export const MAX_MESSAGES = 500;
export const ONLINE_TIMEOUT = 15 * 1000;
export const IMAGE_MAX_WIDTH = 640;
export const PIECE_SIZE = 128 * 1024;
export const TYPING_INDICATOR_TIMEOUT = 500;
export const MAX_CONCURRENT_REQUESTS = 8;
export const PIECE_REQUEST_TIMEOUT = 10000;
export const MAX_BLOB_ASSEMBLY_SIZE = 100 * 1024 * 1024; // 100 MB
export const METADATA_CHUNK_SIZE = 500; // Number of hashes per metadata message chunk
export const PFS_REKEY_INTERVAL = 60 * 1000; // 60 seconds

export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
export const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];
