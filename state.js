// state.js

export const state = {
    streamr: null,
    db: null,
    currentRoomId: 'Lobby',
    currentRoomType: 'chat', // NEW: To track the current room's layout
    roomPasswords: new Map(),
    roomSettings: new Map(), // Will now store { isPFS, roomType, streamerId }
    fileWorker: null,
    streamerWorker: null,
    myPublisherId: '',
    myNickname: '',
    myRealAddress: '',
    isGhostMode: false,
    userNicknames: new Map(),
    userRealAddresses: new Map(),
    verifiedRealAddresses: new Map(),
    userColors: new Map(),
    lastMessages: [],
    messageCounter: 0,
    activeUsers: new Map(),
    activeRooms: new Map(),
    loadedImages: new Map(),
    localFiles: new Map(),
    incomingFiles: new Map(),
    fileSeeders: new Map(),
    localFileMetadata: new Map(),
    incomingFileMetadata: new Map(),
    localMediaStream: null,
    currentVideoTrack: null,
    isFlashlightOn: false,
    videoStreamInterval: null,
    currentLiveStreamId: null,
    currentLiveStreamType: null, // 'video' or 'audio'
    audioContext: null,
    audioProcessor: null,
    remoteStreams: new Map(),
    messageReactions: new Map(),
    typingUsers: new Map(),
    isTypingTimeout: null,
    replyingTo: null,
    presenceInterval: null,
    rekeyInterval: null,
    selectedFile: null,
    selectedFileIntent: 'file',
    myPFSKeyPair: null,
    pfsUserPublicKeys: new Map(),
    currentEpochKey: null,
    currentEpochId: null,
  
    pendingSentMessages: new Set(),
    streamSettings: {
        width: 854,
        height: 480,
        frameRate: 15,
        jpegQuality: 0.5
    }
};
