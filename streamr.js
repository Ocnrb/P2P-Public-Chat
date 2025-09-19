// streamr.js

// Este módulo lida com todas as interações com a rede Streamr,
// incluindo autenticação, publicação, subscrição e processamento de mensagens recebidas.

import { state } from './state.js';
import * as config from './config.js';
import * as cryptoUtils from './cryptoUtils.js';
import * as dom from './dom.js';
import * as ui from './ui.js';
import * as utils from './utils.js';
import * as fileTransfer from './file-transfer.js';
import * as workers from './workers.js';

// --- Handlers Internos de Mensagens ---

async function handleLastMessagesPayload(payload, metadata) {
    // MODIFIED: We no longer clear the entire chat history.
    // We just process each message and let processAndDisplayMessage decide if it should be added.
    if (payload.Counter > state.messageCounter && payload.lastMessages) {
        for (const msg of payload.lastMessages) {
            const msgMetadata = { publisherId: msg.userId, timestamp: msg.timestamp };
            await processAndDisplayMessage(msg, msgMetadata, true); // true for isHistorical
        }
        state.messageCounter = payload.Counter;
        state.lastMessages = payload.lastMessages;
    }

    if (payload.Reactions) {
        for (const [msgId, reactions] of Object.entries(payload.Reactions)) {
            if (!state.messageReactions.has(msgId)) {
                state.messageReactions.set(msgId, reactions);
            }
        }
        document.querySelectorAll('.message-entry').forEach(msgDiv => {
            const msgId = msgDiv.id.replace('msg-', '');
            ui.updateReactionsUI(msgId, state.messageReactions, state.myPublisherId);
        });
    }

    if (payload.verifiedUsers) {
        payload.verifiedUsers.forEach(([sessionId, realAddress]) => {
            state.verifiedRealAddresses.set(sessionId, realAddress);
        });
        ui.updateUserList(state.activeUsers, state.verifiedRealAddresses, utils.getDisplayName, utils.getUserColor);
    }
}


async function handleDataRequest(message) {
    if (message.roomId !== state.currentRoomId) return;

    if (message.type === 'image_request' && message.dataId) {
        const imageData = state.loadedImages.get(message.dataId);
        if (imageData) {
            const password = state.roomPasswords.get(state.currentRoomId);
            const currentRoomSettings = state.roomSettings.get(state.currentRoomId);
            let imagePayload;

            if (currentRoomSettings && currentRoomSettings.isPFS && state.currentEpochKey) {
                 const encrypted = await cryptoUtils.encryptMessage(cryptoUtils.textEncoder.encode(imageData), state.currentEpochKey);
                 imagePayload = { roomId: state.currentRoomId, id: message.dataId, type: 'pfs_encrypted_image', epochId: state.currentEpochId, ...encrypted };
            } else if (password) {
                const key = await cryptoUtils.deriveKeyFromPassword(password, state.currentRoomId);
                const encrypted = await cryptoUtils.encryptMessage(cryptoUtils.textEncoder.encode(imageData), key);
                imagePayload = { roomId: state.currentRoomId, id: message.dataId, encryptedData: encrypted.content, iv: encrypted.iv };
            } else {
                imagePayload = { roomId: state.currentRoomId, id: message.dataId, data: imageData };
            }
            await state.streamr.publish(config.IMAGE_STREAM_ID, imagePayload);
        }
    }
}

async function requestData(dataType, dataId) {
    if (!state.streamr) return;
    const payload = {
        roomId: state.currentRoomId,
        type: `${dataType}_request`,
        dataId: dataId,
    };
    await state.streamr.publish(config.METRICS_STREAM_ID, payload);
}

async function processAndDisplayMessage(message, metadata, isHistorical = false) {
    const messageId = message.id || metadata.timestamp;
    if (state.pendingSentMessages.has(messageId)) {
        state.pendingSentMessages.delete(messageId);
        return;
    }
    
    if (message.roomId !== state.currentRoomId) {
        return;
    }

    const originalMessageForHistory = {...message};
    
    const existingMsg = document.getElementById(`msg-${messageId}`);
    if (existingMsg) {
        // ADDED: More robust check. If a video message bubble already contains a video player,
        // it means the file was downloaded/processed. We should never replace it.
        if ((message.type === 'video_announce' || message.type === 'file_announce') && existingMsg.querySelector('video')) {
            return;
        }

        const existingSeal = existingMsg.querySelector('.message-seal');
        const isExistingHistorical = existingSeal && existingSeal.dataset.sealType === 'historical';

        // If the new message is LIVE (!isHistorical) and the one on screen is HISTORICAL, we upgrade it.
        if (!isHistorical && isExistingHistorical) {
            existingMsg.remove(); // Remove the old one to replace it below.
        } else {
            // In all other cases (live/live, historical/historical, or historical trying to replace live),
            // we do nothing.
            return;
        }
    }

    if (message.type === 'pfs_encrypted') {
        if (state.currentEpochKey && message.epochId === state.currentEpochId) {
            const decryptedPayloadBuffer = await cryptoUtils.decryptMessage(message.content, state.currentEpochKey, message.iv);
            if (decryptedPayloadBuffer) {
                const decryptedPayload = JSON.parse(cryptoUtils.textDecoder.decode(decryptedPayloadBuffer));
                message = {...message, ...decryptedPayload};
            } else { message.type = 'decryption_failed'; }
        } else { message.type = 'decryption_failed_epoch_mismatch'; }
    } else if (message.type === 'encrypted') {
        const password = state.roomPasswords.get(message.roomId);
        if (password) {
            const key = await cryptoUtils.deriveKeyFromPassword(password, message.roomId);
            const decryptedPayloadBuffer = await cryptoUtils.decryptMessage(message.payload, key, message.iv);
            if (decryptedPayloadBuffer) {
                const decryptedPayload = JSON.parse(cryptoUtils.textDecoder.decode(decryptedPayloadBuffer));
                message = {...message, ...decryptedPayload};
            } else { message.type = 'decryption_failed'; }
        } else { message.type = 'decryption_failed'; }
    }

    if (message.tempId) {
        const tempElement = document.getElementById(message.tempId);
        if (tempElement) tempElement.remove();
    }
    
    if (message.realAddress) { state.userRealAddresses.set(metadata.publisherId, message.realAddress); }
    if (message.nickname) { const addressKey = state.userRealAddresses.get(metadata.publisherId) || metadata.publisherId; state.userNicknames.set(addressKey, utils.sanitizeHTML(message.nickname)); }

    const helpers = { myPublisherId: state.myPublisherId, getDisplayName: utils.getDisplayName, getUserColor: utils.getUserColor, getNickname: utils.getNickname, verifiedRealAddresses: state.verifiedRealAddresses, userRealAddresses: state.userRealAddresses, sanitizeHTML: utils.sanitizeHTML };
    const msgDiv = ui.createMessageElement(message, metadata, isHistorical, helpers);
    ui.addMessageToUI(msgDiv, isHistorical);
    ui.updateReactionsUI(messageId, state.messageReactions, state.myPublisherId);

    if (message.type === 'start_stream') {
        if (message.streamType === 'audio') {
            state.remoteStreams.set(message.streamId, { audioContext: null });
        } else { // 'video' or legacy
             const roomSettings = state.roomSettings.get(state.currentRoomId) || {};
             if (roomSettings.roomType === 'streamer') {
                // In streamer room, create the main canvas for the viewer
                const canvas = document.createElement('canvas');
                canvas.id = `stream-${message.streamId}`;
                canvas.width = 854; 
                canvas.height = 480;
                canvas.className = 'bg-black rounded-md w-full h-auto'; 
                dom.streamViewerPanel.innerHTML = ''; // Clear "Stream offline" message
                dom.streamViewerPanel.appendChild(canvas);

                const ctx = canvas.getContext('2d');
                const videoWorker = workers.createVideoViewerWorker(ctx);
                state.remoteStreams.set(message.streamId, { videoWorker, audioContext: null });
             } else {
                // In chat room, create the small canvas inside the message bubble
                const canvas = document.getElementById(`stream-${message.streamId}`);
                if (canvas) {
                    const ctx = canvas.getContext('2d');
                    const videoWorker = workers.createVideoViewerWorker(ctx);
                    state.remoteStreams.set(message.streamId, {videoWorker, audioContext: null});
                }
             }
        }
    } else if (message.type === 'image' && isHistorical) {
        requestData('image', message.imageId);
    } else if (message.type === 'file_announce' || message.type === 'video_announce') {
        if (metadata.publisherId !== state.myPublisherId) {
            const { fileId } = message.metadata;
            state.incomingFiles.set(fileId, { metadata: message.metadata, requestsInFlight: new Map(), receivedCount: 0 });
            fileTransfer.requestFileSources(fileId);
        }
    } else if (message.type === 'stop_stream') {
        const streamInfo = state.remoteStreams.get(message.streamId);
        if (streamInfo) {
            if (streamInfo.audioContext) streamInfo.audioContext.close();
            if (streamInfo.videoWorker) streamInfo.videoWorker.terminate();
            state.remoteStreams.delete(message.streamId);
        }
        const roomSettings = state.roomSettings.get(state.currentRoomId) || {};
        if (roomSettings.roomType === 'streamer') {
            dom.streamViewerPanel.innerHTML = '<p class="text-gray-500 flex items-center justify-center h-full">Stream offline</p>';
        }
    }

    if (!isHistorical) {
        const currentRoomSettings = state.roomSettings.get(state.currentRoomId);
        if (!currentRoomSettings || !currentRoomSettings.isPFS) {
            state.messageCounter++;
            const standardizedMessage = { ...originalMessageForHistory, timestamp: metadata.timestamp, userId: metadata.publisherId };
            state.lastMessages.push(standardizedMessage);
            if (state.lastMessages.length > config.MAX_MESSAGES) state.lastMessages.shift();
            publishLastMessages();
        }
    }
}


async function handleImageMessage(message) {
    if (message.roomId !== state.currentRoomId) return;
    let imageData;
    if (message.type === 'pfs_encrypted_image') {
        if (state.currentEpochKey && message.epochId === state.currentEpochId) {
            const decryptedBuffer = await cryptoUtils.decryptMessage(message.content, state.currentEpochKey, message.iv);
            if (decryptedBuffer) imageData = cryptoUtils.textDecoder.decode(decryptedBuffer); else return;
        } else return;
    } else if (message.encryptedData) {
        const password = state.roomPasswords.get(state.currentRoomId);
        if (password) {
            const key = await cryptoUtils.deriveKeyFromPassword(password, state.currentRoomId);
            const decryptedBuffer = await cryptoUtils.decryptMessage(message.encryptedData, key, message.iv);
            if (decryptedBuffer) imageData = cryptoUtils.textDecoder.decode(decryptedBuffer); else return;
        } else return;
    } else {
        imageData = message.data;
    }
    state.loadedImages.set(message.id, imageData);
    const imgContainer = document.querySelector(`[data-image-id="${message.id}"]`);
    if (imgContainer) {
        imgContainer.innerHTML = `<img src="${imageData}" class="max-w-xs rounded-md" />`;
    }
}

async function handleVideoStreamMessage(message) {
    if (message.roomId !== state.currentRoomId) return;
    let frameDataBuffer;
    if (message.type === 'pfs_encrypted_frame') {
        if (state.currentEpochKey && message.epochId === state.currentEpochId) {
            frameDataBuffer = await cryptoUtils.decryptMessage(message.content, state.currentEpochKey, message.iv);
        }
    } else if (message.encryptedFrame) {
        const password = state.roomPasswords.get(state.currentRoomId);
        if (password) {
            const key = await cryptoUtils.deriveKeyFromPassword(password, state.currentRoomId);
            frameDataBuffer = await cryptoUtils.decryptMessage(message.encryptedFrame, key, message.iv);
        }
    } else {
        frameDataBuffer = cryptoUtils.base64ToArrayBuffer(message.frame);
    }
    if (!frameDataBuffer) return;
    const streamInfo = state.remoteStreams.get(message.streamId);
    if (streamInfo && streamInfo.videoWorker) {
        streamInfo.videoWorker.postMessage({frame: frameDataBuffer}, [frameDataBuffer]);
    }
}

async function handleAudioStreamMessage(message) {
    if (message.roomId !== state.currentRoomId || message.streamId === state.currentLiveStreamId) return;
    let audioDataArray;
    if (message.type === 'pfs_encrypted_audio') {
        if (state.currentEpochKey && message.epochId === state.currentEpochId) {
            const decryptedBuffer = await cryptoUtils.decryptMessage(message.content, state.currentEpochKey, message.iv);
            if (decryptedBuffer) audioDataArray = JSON.parse(cryptoUtils.textDecoder.decode(decryptedBuffer));
        }
    } else if (message.encryptedAudio) {
        const password = state.roomPasswords.get(state.currentRoomId);
        if (password) {
            const key = await cryptoUtils.deriveKeyFromPassword(password, state.currentRoomId);
            const decryptedBuffer = await cryptoUtils.decryptMessage(message.encryptedAudio, key, message.iv);
            if (decryptedBuffer) audioDataArray = JSON.parse(cryptoUtils.textDecoder.decode(decryptedBuffer));
        }
    } else {
        audioDataArray = message.audioData;
    }
    if (!audioDataArray) return;

    let streamInfo = state.remoteStreams.get(message.streamId);
    if (!streamInfo) return;

    // Se o processador de áudio para este stream não foi inicializado, cria-o.
    if (!streamInfo.audioPlayerNode) {
        try {
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            await audioContext.audioWorklet.addModule('audio-worklet-processor.js');
            const audioPlayerNode = new AudioWorkletNode(audioContext, 'player-processor');
            audioPlayerNode.connect(audioContext.destination);
            
            // Armazena o nó e o contexto no estado para uso futuro e limpeza.
            streamInfo.audioContext = audioContext;
            streamInfo.audioPlayerNode = audioPlayerNode;
        } catch (e) {
            console.error('Falha ao inicializar o processador Audio Worklet:', e);
            // Se falhar, não podemos processar mais áudio para este stream.
            return;
        }
    }

    // Se o contexto de áudio estiver suspenso (política de autoplay do browser), tenta retomá-lo.
    if (streamInfo.audioContext.state === 'suspended') {
        streamInfo.audioContext.resume();
    }
    
    // Envia os dados de áudio para o worklet para serem bufferizados e reproduzidos.
    const audioData = new Float32Array(audioDataArray);
    streamInfo.audioPlayerNode.port.postMessage(audioData);
}

async function handleReactionMessage(message, metadata) {
    if (message.roomId !== state.currentRoomId) return;
    let reactionMessage = message;
    if (message.type === 'pfs_encrypted') {
        if (state.currentEpochKey && message.epochId === state.currentEpochId) {
            const decryptedBuffer = await cryptoUtils.decryptMessage(message.content, state.currentEpochKey, message.iv);
            if (decryptedBuffer) reactionMessage = JSON.parse(cryptoUtils.textDecoder.decode(decryptedBuffer)); else return;
        } else return;
    } else if (message.encryptedPayload) {
        const password = state.roomPasswords.get(state.currentRoomId);
        if (password) {
            const key = await cryptoUtils.deriveKeyFromPassword(password, state.currentRoomId);
            const decryptedBuffer = await cryptoUtils.decryptMessage(message.encryptedPayload, key, message.iv);
            if (decryptedBuffer) reactionMessage = JSON.parse(cryptoUtils.textDecoder.decode(decryptedBuffer)); else return;
        } else return;
    }
    const {messageId, emoji, userId} = reactionMessage;
    if (!state.messageReactions.has(messageId)) {
        state.messageReactions.set(messageId, {});
    }
    const reactionsForMsg = state.messageReactions.get(messageId);
    if (!reactionsForMsg[emoji]) {
        reactionsForMsg[emoji] = [];
    }
    const userIndex = reactionsForMsg[emoji].indexOf(userId);
    if (userIndex > -1) {
        reactionsForMsg[emoji].splice(userIndex, 1);
    } else {
        reactionsForMsg[emoji].push(userId);
    }
    ui.updateReactionsUI(messageId, state.messageReactions, state.myPublisherId);
}

function handleTypingPayload(metadata) {
    if (metadata.publisherId !== state.myPublisherId) {
        state.typingUsers.set(metadata.publisherId, Date.now());
        ui.updateTypingIndicatorUI(state.typingUsers, utils.getDisplayName);
    }
}

async function handleTypingMessage(message, metadata) {
    if (message.roomId !== state.currentRoomId) return;
    if (message.type === 'is_typing') {
        handleTypingPayload(metadata);
    } else if (message.type === 'pfs_encrypted_typing') {
        if (state.currentEpochKey && message.epochId === state.currentEpochId) {
            const decryptedBuffer = await cryptoUtils.decryptMessage(message.content, state.currentEpochKey, message.iv);
            if (decryptedBuffer) handleTypingPayload(metadata);
        }
    } else if (message.type === 'encrypted_typing') {
        const password = state.roomPasswords.get(state.currentRoomId);
        if (!password) return;
        try {
            const key = await cryptoUtils.deriveKeyFromPassword(password, state.currentRoomId);
            if (await cryptoUtils.decryptMessage(message.payload, key, message.iv)) {
                handleTypingPayload(metadata);
            }
        } catch (e) {}
    }
}

async function handlePFSControlMessage(message, metadata) {
    if (message.roomId !== state.currentRoomId) return;

    if (message.type === 'publicKey_announce' && metadata.publisherId !== state.myPublisherId) {
        try {
            if (!state.pfsUserPublicKeys.has(metadata.publisherId)) {
                const importedKey = await cryptoUtils.importPublicKey(message.publicKey);
                state.pfsUserPublicKeys.set(metadata.publisherId, importedKey);
                await announcePublicKey();
            }
        } catch (e) { console.error("Falha ao importar a chave pública:", e); }
    } else if (message.type === 'epoch_key_distribution') {
        // CORREÇÃO: Removida a verificação estrita do líder para evitar race conditions.
        // Um cliente aceitará uma nova chave se for para ele e for de uma época mais recente.
        if (message.recipient === state.myPublisherId) {
            if(message.epochId > (state.currentEpochId || 0)) {
                const senderPublicKey = state.pfsUserPublicKeys.get(metadata.publisherId);
                if (senderPublicKey) {
                    try {
                        const sharedSecret = await window.crypto.subtle.deriveKey({name: 'ECDH', public: senderPublicKey}, state.myPFSKeyPair.privateKey, {name: 'AES-GCM', length: 256}, true, ['encrypt', 'decrypt']);
                        const decryptedPayload = await cryptoUtils.decryptMessage(message.content, sharedSecret, message.iv);
                        if (decryptedPayload) {
                            const keyJwk = JSON.parse(cryptoUtils.textDecoder.decode(decryptedPayload));
                            state.currentEpochKey = await window.crypto.subtle.importKey('jwk', keyJwk, {name: 'AES-GCM'}, true, ['encrypt', 'decrypt']);
                            state.currentEpochId = message.epochId;
                        }
                    } catch (e) { console.error("Falha ao desencriptar a chave de época:", e); }
                }
            }
        }
    } else if (message.type === 'rekey_request') {
        if (determineEpochLeader() === state.myPublisherId) {
            await initiateRekeying();
        }
    }
}

async function processMetricsMessage(message, metadata) {
    if (message.type === 'presence' || message.type === 'pfs_encrypted_presence' || message.type === 'encrypted_presence') {
        let payload = message;
        if(message.type !== 'presence') {
            const discoveryPayload = {roomId: message.roomId, isPrivate: true};
            handlePresencePayload(discoveryPayload, metadata);
            if (message.roomId !== state.currentRoomId) return;

            try {
                let decryptedPayloadBuffer;
                if(message.type === 'pfs_encrypted_presence' && state.currentEpochKey) {
                    decryptedPayloadBuffer = await cryptoUtils.decryptMessage(message.content, state.currentEpochKey, message.iv);
                } else if (message.type === 'encrypted_presence') {
                    const password = state.roomPasswords.get(state.currentRoomId);
                    if(password) {
                        const key = await cryptoUtils.deriveKeyFromPassword(password, state.currentRoomId);
                        decryptedPayloadBuffer = await cryptoUtils.decryptMessage(message.payload, key, message.iv);
                    }
                }
                if (decryptedPayloadBuffer) {
                    payload = JSON.parse(cryptoUtils.textDecoder.decode(decryptedPayloadBuffer));
                } else {
                    return;
                }
            } catch(e) { return; }
        }
        handlePresencePayload(payload, metadata);
    } else if (message.type === 'last_messages' || message.type === 'encrypted_last_messages') {
        if (message.roomId !== state.currentRoomId) return;
        let payload = message;
        if(message.type === 'encrypted_last_messages') {
            const password = state.roomPasswords.get(state.currentRoomId);
            if (!password) return;
            try {
                const key = await cryptoUtils.deriveKeyFromPassword(password, state.currentRoomId);
                const decryptedPayloadBuffer = await cryptoUtils.decryptMessage(message.payload, key, message.iv);
                if (decryptedPayloadBuffer) {
                    payload = JSON.parse(cryptoUtils.textDecoder.decode(decryptedPayloadBuffer));
                } else {
                    return;
                }
            } catch (e) { return; }
        }
        await handleLastMessagesPayload(payload, metadata);
    } else if (message.type === 'identity_proof') {
        if (message.roomId !== state.currentRoomId) return;
        try {
            const recoveredAddress = ethers.utils.verifyMessage(message.proofMsg, message.signature);
            if (recoveredAddress.toLowerCase() === message.realAddress.toLowerCase()) {
                state.verifiedRealAddresses.set(message.sessionId, message.realAddress);
                state.userRealAddresses.set(message.sessionId, message.realAddress);
                const helpers = { activeUsers: state.activeUsers, verifiedRealAddresses: state.verifiedRealAddresses, getDisplayName: utils.getDisplayName, getUserColor: utils.getUserColor, getNickname: utils.getNickname, userRealAddresses: state.userRealAddresses };
                ui.updateUIVerification(message.sessionId, helpers);
            }
        } catch (e) { console.error("Falha ao verificar a prova de identidade:", e); }
    } else if (message.type.endsWith('_request')) {
        handleDataRequest(message);
    }
}


// --- Lógica Interna ---

function cleanupInactiveUsers() {
    const now = Date.now();
    let changed = false;
    for (const [userId, data] of state.activeUsers.entries()) {
        if (now - data.lastActive > config.ONLINE_TIMEOUT) {
            state.activeUsers.delete(userId);
            state.pfsUserPublicKeys.delete(userId);
            changed = true;
        }
    }
    for (const roomData of state.activeRooms.values()) {
        for (const [userId, lastSeen] of roomData.users.entries()) {
            if (now - lastSeen > config.ONLINE_TIMEOUT * 2) {
                roomData.users.delete(userId);
            }
        }
    }
    return changed;
}

function determineEpochLeader() {
    if (state.activeUsers.size === 0) return null;
    return [...state.activeUsers.keys()].sort()[0];
}

async function announcePublicKey() {
    if (!state.streamr || !state.myPFSKeyPair) return;
    const exportedPublicKey = await cryptoUtils.exportPublicKey(state.myPFSKeyPair.publicKey);
    await state.streamr.publish(config.PFS_CONTROL_STREAM_ID, {
        roomId: state.currentRoomId,
        type: 'publicKey_announce',
        publicKey: exportedPublicKey
    });
}

async function initiateRekeying() {
    const leaderId = determineEpochLeader();
    if (leaderId !== state.myPublisherId) return;

    try {
        const newEpochKey = await window.crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, true, ['encrypt', 'decrypt']);
        const newEpochId = Date.now();

        if (state.activeUsers.size <= 1) {
            state.currentEpochKey = newEpochKey;
            state.currentEpochId = newEpochId;
            return;
        }

        const exportedEpochKey = await window.crypto.subtle.exportKey('jwk', newEpochKey);
        const keyDistributionPayload = { roomId: state.currentRoomId, type: 'epoch_key_distribution', epochId: newEpochId };
        const distributionPromises = [];

        for (const userId of state.activeUsers.keys()) {
            if (userId === state.myPublisherId) continue;

            const userPublicKey = state.pfsUserPublicKeys.get(userId);
            if (userPublicKey) {
                const finalPayload = {...keyDistributionPayload, recipient: userId};
                const sharedSecret = await window.crypto.subtle.deriveKey({name: 'ECDH', public: userPublicKey}, state.myPFSKeyPair.privateKey, {name: 'AES-GCM', length: 256}, true, ['encrypt', 'decrypt']);
                const payloadToEncrypt = cryptoUtils.textEncoder.encode(JSON.stringify(exportedEpochKey));
                const encryptedPayload = await cryptoUtils.encryptMessage(payloadToEncrypt, sharedSecret);
                finalPayload.content = encryptedPayload.content;
                finalPayload.iv = encryptedPayload.iv;
                distributionPromises.push(state.streamr.publish(config.PFS_CONTROL_STREAM_ID, finalPayload));
            }
        }
        
        await Promise.all(distributionPromises);
        
        state.currentEpochKey = newEpochKey;
        state.currentEpochId = newEpochId;

    } catch (error) { console.error("CRÍTICO: Falha durante initiateRekeying:", error); }
}

function handlePresencePayload(payload, metadata) {
    const now = Date.now();
    
    if (payload.roomId === state.currentRoomId) {
        if (payload.realAddress) state.userRealAddresses.set(metadata.publisherId, payload.realAddress);
        if (payload.nickname) {
            const addressKey = payload.realAddress || metadata.publisherId;
            state.userNicknames.set(addressKey, payload.nickname);
        }
        state.activeUsers.set(metadata.publisherId, {lastActive: now});
    }
    
    if (payload.roomId) {
        if (!state.activeRooms.has(payload.roomId)) state.activeRooms.set(payload.roomId, { users: new Map(), lastSeen: now });
        const roomData = state.activeRooms.get(payload.roomId);
        roomData.users.set(metadata.publisherId, now);
        roomData.lastSeen = now;
        roomData.isPrivate = payload.isPrivate || false;
        if (payload.roomSettings) {
            state.roomSettings.set(payload.roomId, payload.roomSettings);
        }
    }
    
    const membershipChanged = cleanupInactiveUsers();
    if (membershipChanged) {
        // A atualização da UI acontecerá no intervalo principal
    }
}


// --- Funções Exportadas ---

async function publishLastMessages() {
    const currentRoomSettings = state.roomSettings.get(state.currentRoomId);
    if (!state.streamr || (currentRoomSettings && currentRoomSettings.isPFS) || state.isGhostMode) return;
    try {
        const recentMessageIds = new Set(state.lastMessages.map(m => m.id || m.timestamp));
        const recentReactions = {};
        for (const [msgId, reactions] of state.messageReactions.entries()) {
            if (recentMessageIds.has(msgId)) recentReactions[msgId] = reactions;
        }
        const payload = {
            lastMessages: state.lastMessages, Counter: state.messageCounter,
            Reactions: recentReactions, verifiedUsers: Array.from(state.verifiedRealAddresses.entries()), type: 'last_messages'
        };
        const password = state.roomPasswords.get(state.currentRoomId);
        if (password) {
            const key = await cryptoUtils.deriveKeyFromPassword(password, state.currentRoomId);
            const encrypted = await cryptoUtils.encryptMessage(cryptoUtils.textEncoder.encode(JSON.stringify(payload)), key);
            await state.streamr.publish(config.METRICS_STREAM_ID, { roomId: state.currentRoomId, type: 'encrypted_last_messages', iv: encrypted.iv, payload: encrypted.content });
        } else {
            await state.streamr.publish(config.METRICS_STREAM_ID, { roomId: state.currentRoomId, ...payload });
        }
    } catch (err) {}
}

export async function publishPresence() {
    if (!state.streamr || state.isGhostMode) return;
    try {
        let payload = { type: 'presence', lastActive: Date.now(), nickname: state.myNickname, realAddress: state.myRealAddress, roomId: state.currentRoomId };
        const currentRoomSettings = state.roomSettings.get(state.currentRoomId);
        if (currentRoomSettings) payload.roomSettings = currentRoomSettings;
        payload.isPrivate = state.roomPasswords.has(state.currentRoomId) || (currentRoomSettings && currentRoomSettings.isPFS);
        if (state.currentLiveStreamId) {
            payload.isStreaming = true;
            payload.streamId = state.currentLiveStreamId;
            payload.streamType = state.currentLiveStreamType;
        }
        const password = state.roomPasswords.get(state.currentRoomId);
        if (currentRoomSettings && currentRoomSettings.isPFS && state.currentEpochKey) {
            const encrypted = await cryptoUtils.encryptMessage(cryptoUtils.textEncoder.encode(JSON.stringify(payload)), state.currentEpochKey);
            await state.streamr.publish(config.METRICS_STREAM_ID, { roomId: state.currentRoomId, type: 'pfs_encrypted_presence', epochId: state.currentEpochId, ...encrypted });
        } else if (password) {
            const key = await cryptoUtils.deriveKeyFromPassword(password, state.currentRoomId);
            const encrypted = await cryptoUtils.encryptMessage(cryptoUtils.textEncoder.encode(JSON.stringify(payload)), key);
            await state.streamr.publish(config.METRICS_STREAM_ID, { roomId: state.currentRoomId, type: 'encrypted_presence', iv: encrypted.iv, payload: encrypted.content });
        } else {
            await state.streamr.publish(config.METRICS_STREAM_ID, payload);
        }
    } catch (err) {}
}

export async function switchRoom(newRoomId) {
    if (newRoomId === state.currentRoomId) return;

    if (state.rekeyInterval) clearInterval(state.rekeyInterval);
    state.rekeyInterval = null;

    // Reset UI containers
    dom.messagesContainer.innerHTML = '';
    dom.streamerChatContainer.innerHTML = ''; // Also clear streamer chat

    Object.assign(state, { 
        lastMessages: [], 
        activeUsers: new Map(),
        messageCounter: 0, 
        messageReactions: new Map(), 
        typingUsers: new Map(), 
        myPFSKeyPair: null, 
        pfsUserPublicKeys: new Map(), 
        currentEpochKey: null, 
        currentEpochId: null 
    });

    if (!state.isGhostMode) {
        state.activeUsers.set(state.myPublisherId, {lastActive: Date.now()});
    }

    ui.updateUserList(state.activeUsers, state.verifiedRealAddresses, utils.getDisplayName, utils.getUserColor);

    state.currentRoomId = newRoomId;
    const currentRoomSettings = state.roomSettings.get(state.currentRoomId) || {};
    const roomType = currentRoomSettings.roomType || 'chat';
    state.currentRoomType = roomType;

    // Toggle layouts based on room type
    if (roomType === 'streamer') {
        dom.chatUI.classList.add('hidden');
        dom.streamerLayout.classList.remove('hidden');
        dom.streamViewerPanel.innerHTML = '<p class="text-gray-500 flex items-center justify-center h-full">Stream offline</p>';
    } else { // 'chat'
        dom.streamerLayout.classList.add('hidden');
        dom.chatUI.classList.remove('hidden');
    }

    const isPrivate = state.roomPasswords.has(state.currentRoomId) || currentRoomSettings.isPFS;
    const isPFS = currentRoomSettings.isPFS;
    dom.chatTitle.textContent = newRoomId + (isPrivate ? ' 🔒' : '') + (isPFS ? ' 🛡️' : '');
    
    dom.rekeyBtn.classList.toggle('hidden', !isPFS);
    
    publishPresence();
    if (isPFS) {
        state.myPFSKeyPair = await cryptoUtils.generatePFSKeyPair();
        await announcePublicKey();
        
        initiateRekeying(); // Rekey inicial ao entrar
        state.rekeyInterval = setInterval(initiateRekeying, config.PFS_REKEY_INTERVAL);
    }
}

export async function sendMessage() {
    const input = state.currentRoomType === 'streamer' ? dom.messageInputStreamer : dom.messageInput;
    const text = input.value.trim();
    if (!text || !state.streamr) return;

    const sendButton = state.currentRoomType === 'streamer' ? dom.sendBtnStreamer : dom.sendBtn;
    if (sendButton.disabled) return;
    sendButton.disabled = true;

    try {
        let messagePayload = { type: 'text', content: text, id: crypto.randomUUID(), nickname: state.myNickname, realAddress: state.myRealAddress };
        if (state.replyingTo) {
            Object.assign(messagePayload, {
                replyToMessageId: state.replyingTo.id || state.replyingTo.timestamp,
                replyToUser: state.replyingTo.userId,
                replyToContent: state.replyingTo.type === 'text' ? state.replyingTo.content : (state.replyingTo.type === 'image' ? 'Image' : `File: ${state.replyingTo.metadata.fileName}`)
            });
        }
        const currentRoomSettings = state.roomSettings.get(state.currentRoomId);
        const password = state.roomPasswords.get(state.currentRoomId);
        let finalPayload;
        if (currentRoomSettings && currentRoomSettings.isPFS) {
            if (state.currentEpochKey) {
                const encrypted = await cryptoUtils.encryptMessage(cryptoUtils.textEncoder.encode(JSON.stringify(messagePayload)), state.currentEpochKey);
                finalPayload = { roomId: state.currentRoomId, type: 'pfs_encrypted', epochId: state.currentEpochId, ...encrypted };
            } else {
                ui.showCustomAlert('Não Pronto', 'A aguardar pela chave de época segura...');
                sendButton.disabled = false;
                return;
            }
        } else if (password) {
            const key = await cryptoUtils.deriveKeyFromPassword(password, state.currentRoomId);
            const encrypted = await cryptoUtils.encryptMessage(cryptoUtils.textEncoder.encode(JSON.stringify(messagePayload)), key);
            finalPayload = { roomId: state.currentRoomId, type: 'encrypted', iv: encrypted.iv, payload: encrypted.content };
        } else {
            finalPayload = {...messagePayload, roomId: state.currentRoomId};
        }
        await state.streamr.publish(config.CHAT_STREAM_ID, finalPayload);
        input.value = '';
        input.focus();
        if (state.isTypingTimeout) clearTimeout(state.isTypingTimeout);
        state.isTypingTimeout = null;
        if (state.replyingTo) {
            state.replyingTo = null;
            dom.replyingToContainer.classList.add('hidden');
        }
    } catch (error) {
        ui.showCustomAlert('Erro', 'Falha ao enviar mensagem: ' + error.message);
    } finally {
        sendButton.disabled = false;
    }
}

export async function sendReaction(messageId, emoji) {
    if (!state.streamr) return;
    try {
        const payload = {messageId, emoji, userId: state.myPublisherId};
        const password = state.roomPasswords.get(state.currentRoomId);
        const currentRoomSettings = state.roomSettings.get(state.currentRoomId);
        let finalPayload;
        if (currentRoomSettings && currentRoomSettings.isPFS) {
            if (state.currentEpochKey) {
                const encrypted = await cryptoUtils.encryptMessage(cryptoUtils.textEncoder.encode(JSON.stringify(payload)), state.currentEpochKey);
                finalPayload = { roomId: state.currentRoomId, type: 'pfs_encrypted', epochId: state.currentEpochId, ...encrypted };
            } else return;
        } else if (password) {
            const key = await cryptoUtils.deriveKeyFromPassword(password, state.currentRoomId);
            const encrypted = await cryptoUtils.encryptMessage(cryptoUtils.textEncoder.encode(JSON.stringify(payload)), key);
            finalPayload = { roomId: state.currentRoomId, encryptedPayload: encrypted.content, iv: encrypted.iv };
        } else {
            finalPayload = {roomId: state.currentRoomId, ...payload};
        }
        await state.streamr.publish(config.REACTION_STREAM_ID, finalPayload);
    } catch (error) {}
}

export async function sendTypingSignal() {
    if (!state.streamr || state.isGhostMode) return;
    try {
        const password = state.roomPasswords.get(state.currentRoomId);
        const currentRoomSettings = state.roomSettings.get(state.currentRoomId);
        let payload;
        if (currentRoomSettings && currentRoomSettings.isPFS) {
            if (state.currentEpochKey) {
                const encrypted = await cryptoUtils.encryptMessage(cryptoUtils.textEncoder.encode(JSON.stringify({type: 'is_typing'})), state.currentEpochKey);
                payload = { roomId: state.currentRoomId, type: 'pfs_encrypted_typing', epochId: state.currentEpochId, ...encrypted };
            } else return;
        } else if (password) {
            const key = await cryptoUtils.deriveKeyFromPassword(password, state.currentRoomId);
            const encrypted = await cryptoUtils.encryptMessage(cryptoUtils.textEncoder.encode(JSON.stringify({type: 'is_typing'})), key);
            payload = { roomId: state.currentRoomId, type: 'encrypted_typing', iv: encrypted.iv, payload: encrypted.content };
        } else {
            payload = {roomId: state.currentRoomId, type: 'is_typing'};
        }
        await state.streamr.publish(config.TYPING_STREAM_ID, payload);
    } catch (err) {}
}

export async function sendImage(file, messagePayload, dataId) {
    try {
        const password = state.roomPasswords.get(state.currentRoomId);
        const currentRoomSettings = state.roomSettings.get(state.currentRoomId);
        let finalPayload;
        if (currentRoomSettings && currentRoomSettings.isPFS) {
            if (state.currentEpochKey) {
                const encrypted = await cryptoUtils.encryptMessage(cryptoUtils.textEncoder.encode(JSON.stringify(messagePayload)), state.currentEpochKey);
                finalPayload = { roomId: state.currentRoomId, type: 'pfs_encrypted', epochId: state.currentEpochId, ...encrypted };
            } else { ui.showCustomAlert('Erro', 'Não é possível enviar imagem antes de a sessão segura estar estabelecida.'); return; }
        } else if (password) {
            const key = await cryptoUtils.deriveKeyFromPassword(password, state.currentRoomId);
            const encrypted = await cryptoUtils.encryptMessage(cryptoUtils.textEncoder.encode(JSON.stringify(messagePayload)), key);
            finalPayload = { roomId: state.currentRoomId, type: 'encrypted', iv: encrypted.iv, payload: encrypted.content };
        } else {
            finalPayload = {...messagePayload, roomId: state.currentRoomId};
        }
        await state.streamr.publish(config.CHAT_STREAM_ID, finalPayload);
        utils.resizeImage(file, async (base64Data) => {
            state.loadedImages.set(dataId, base64Data);
            let imagePayload;
            if (currentRoomSettings && currentRoomSettings.isPFS && state.currentEpochKey) {
                const encrypted = await cryptoUtils.encryptMessage(cryptoUtils.textEncoder.encode(base64Data), state.currentEpochKey);
                imagePayload = { roomId: state.currentRoomId, id: dataId, type: 'pfs_encrypted_image', epochId: state.currentEpochId, ...encrypted };
            } else if (password) {
                const key = await cryptoUtils.deriveKeyFromPassword(password, state.currentRoomId);
                const encrypted = await cryptoUtils.encryptMessage(cryptoUtils.textEncoder.encode(base64Data), key);
                imagePayload = { roomId: state.currentRoomId, id: dataId, encryptedData: encrypted.content, iv: encrypted.iv };
            } else {
                imagePayload = {roomId: state.currentRoomId, id: dataId, data: base64Data};
            }
            await state.streamr.publish(config.IMAGE_STREAM_ID, imagePayload);
        });
    } catch (error) {}
}

export async function requestRekey() {
    if (!state.streamr) return;
    const currentRoomSettings = state.roomSettings.get(state.currentRoomId);
    if (currentRoomSettings && currentRoomSettings.isPFS) {
        await state.streamr.publish(config.PFS_CONTROL_STREAM_ID, {
            roomId: state.currentRoomId,
            type: 'rekey_request'
        });
    }
}

async function cleanupClient() {
    if (state.presenceInterval) clearInterval(state.presenceInterval);
    state.presenceInterval = null;
    if (state.rekeyInterval) clearInterval(state.rekeyInterval);
    state.rekeyInterval = null;
    if (state.streamr) {
        await state.streamr.destroy();
        state.streamr = null;
    }
}

export async function initializeChat(authOptions = {}) {
    await cleanupClient();
    try {
        state.streamr = new StreamrClient({...authOptions});
        state.myPublisherId = await state.streamr.getAddress();
        state.isGhostMode = sessionStorage.getItem(`ghostMode_${state.myPublisherId}`) === 'true';
        const nicknameKey = state.myRealAddress || state.myPublisherId;
        state.myNickname = sessionStorage.getItem(`nickname_${nicknameKey}`) || '';
        state.userNicknames.set(nicknameKey, state.myNickname);
        dom.loginModal.classList.add('hidden');
        dom.chatUI.classList.remove('hidden');
        dom.userIdDisplay.textContent = state.myNickname || state.myRealAddress || state.myPublisherId;
        dom.userInfo.classList.remove('hidden');
        dom.chatTitle.textContent = state.currentRoomId;
        dom.walletBtn.title = state.myRealAddress ? 'Desconectar Carteira' : 'Conectar Carteira';

        state.streamr.subscribe(config.CHAT_STREAM_ID, processAndDisplayMessage);
        state.streamr.subscribe(config.IMAGE_STREAM_ID, handleImageMessage);
        state.streamr.subscribe(config.FILE_STREAM_ID, fileTransfer.handleFileStreamMessage);
        state.streamr.subscribe(config.VIDEO_STREAM_ID, handleVideoStreamMessage);
        state.streamr.subscribe(config.AUDIO_STREAM_ID, handleAudioStreamMessage);
        state.streamr.subscribe(config.REACTION_STREAM_ID, handleReactionMessage);
        state.streamr.subscribe(config.TYPING_STREAM_ID, handleTypingMessage);
        state.streamr.subscribe(config.FILE_META_STREAM_ID, fileTransfer.handleFileMetaMessage);
        state.streamr.subscribe(config.METRICS_STREAM_ID, processMetricsMessage);
        state.streamr.subscribe(config.PFS_CONTROL_STREAM_ID, handlePFSControlMessage);

        if (!state.isGhostMode) state.activeUsers.set(state.myPublisherId, {lastActive: Date.now()});
        
        state.presenceInterval = setInterval(() => {
            publishPresence();
            publishLastMessages();

            const membershipChanged = cleanupInactiveUsers();
            if (membershipChanged) {
                 ui.updateUserList(state.activeUsers, state.verifiedRealAddresses, utils.getDisplayName, utils.getUserColor);
            }
            ui.updateTypingIndicatorUI(state.typingUsers, utils.getDisplayName);
            ui.updateRoomListUI(state.activeRooms, state.roomSettings);
        }, 3000);
    } catch (error) {
        throw new Error(`Não foi possível inicializar o chat. ${error.message}`);
    }
}

export async function connectWithWallet() {
    const injectedProvider = window.ethereum || window.top?.ethereum;
    if (!injectedProvider) throw new Error("MetaMask não encontrado.");
    try {
        ui.setLoginModalState('loading');
        const provider = new ethers.providers.Web3Provider(injectedProvider);
        await provider.send("eth_requestAccounts", []);
        const signer = provider.getSigner();
        state.myRealAddress = await signer.getAddress();
        const chainId = await signer.getChainId();
        const domain = { name: 'Public Decentralized Chat', version: '1', chainId, salt: ethers.utils.hexlify(ethers.utils.randomBytes(32)) };
        const types = { Login: [{name: 'purpose', type: 'string'}, {name: 'nonce', type: 'uint256'}] };
        const value = { purpose: 'Assine para criar uma chave de sessão segura para o chat.', nonce: Date.now() };
        const signature = await signer._signTypedData(domain, types, value);
        const sessionPrivateKey = ethers.utils.sha256(ethers.utils.toUtf8Bytes(signature));
        await initializeChat({ auth: { privateKey: sessionPrivateKey } });
        sessionStorage.setItem('authMethod', 'metamask');
        const proofMsg = `Verificando propriedade: O meu endereço ${state.myRealAddress} é representado pela sessão ${state.myPublisherId}`;
        const proofSignature = await signer.signMessage(proofMsg);
        await state.streamr.publish(config.METRICS_STREAM_ID, { roomId: state.currentRoomId, type: 'identity_proof', realAddress: state.myRealAddress, sessionId: state.myPublisherId, proofMsg, signature: proofSignature });
        state.verifiedRealAddresses.set(state.myPublisherId, state.myRealAddress);
        ui.updateUserList(state.activeUsers, state.verifiedRealAddresses, utils.getDisplayName, utils.getUserColor);
    } catch (err) {
        state.myRealAddress = '';
        throw new Error(err.code === 'ACTION_REJECTED' ? "O pedido de assinatura foi rejeitado." : "A conexão com a carteira falhou.");
    }
}

export async function disconnectWallet() {
    await cleanupClient();
    sessionStorage.removeItem('authMethod');
    state.myRealAddress = '';
    window.location.reload();
}

