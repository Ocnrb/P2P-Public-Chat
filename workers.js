// workers.js

// This module sets up and manages Web Workers for offloading heavy tasks
// like file hashing and video processing from the main UI thread.

import { state } from './state.js';
import * as config from './config.js';
import * as cryptoUtils from './cryptoUtils.js';
import * as ui from './ui.js';
import * as utils from './utils.js';

export function createVideoViewerWorker(canvasContext) {
    const workerCode = `
            self.onmessage = async (event) => {
                if (event.data.frame) {
                    try {
                        const blob = new Blob([event.data.frame], { type: 'image/jpeg' });
                        if (blob.size === 0) return;

                        const imageBitmap = await createImageBitmap(blob);
                        self.postMessage({ imageBitmap: imageBitmap }, [imageBitmap]);
                    } catch (e) {
                        console.error('Error decoding frame in viewer worker:', e);
                    }
                }
            };
        `;
    const blob = new Blob([workerCode], {type: 'application/javascript'});
    const worker = new Worker(URL.createObjectURL(blob));
    worker.onmessage = (event) => {
        if (event.data.imageBitmap) {
            const bitmap = event.data.imageBitmap;
            const canvas = canvasContext.canvas;
            
            const videoRatio = bitmap.width / bitmap.height;
            const canvasRatio = canvas.width / canvas.height;
            let drawWidth, drawHeight, x, y;

            // Calculate dimensions to maintain aspect ratio (letterboxing/pillarboxing)
            if (videoRatio > canvasRatio) { 
                drawWidth = canvas.width;
                drawHeight = canvas.width / videoRatio;
                x = 0;
                y = (canvas.height - drawHeight) / 2;
            } else {
                drawHeight = canvas.height;
                drawWidth = canvas.height * videoRatio;
                y = 0;
                x = (canvas.width - drawWidth) / 2;
            }

            canvasContext.clearRect(0, 0, canvas.width, canvas.height);
            canvasContext.drawImage(bitmap, x, y, drawWidth, drawHeight);
            bitmap.close();
        }
    };
    worker.onerror = (error) => {
        console.error("Error in video viewer worker:", error);
    };
    return worker;
}

export function setupFileWorker() {
    // Note: PIECE_SIZE is interpolated into the worker code string.
    const workerCode = `
            const PIECE_SIZE = ${config.PIECE_SIZE};

            async function calculateSHA256(buffer) {
                const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
                const hashArray = Array.from(new Uint8Array(hashBuffer));
                return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
            }

            self.onmessage = async (event) => {
                const { fileStream, fileData, tempId, intent } = event.data;
                const pieceHashes = [];
                const reader = fileStream.getReader();
                let buffer = new Uint8Array(0);

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        if (buffer.length > 0) {
                            const hash = await calculateSHA256(buffer.buffer);
                            pieceHashes.push(hash);
                        }
                        break;
                    }

                    const newBuffer = new Uint8Array(buffer.length + value.length);
                    newBuffer.set(buffer);
                    newBuffer.set(value, buffer.length);
                    buffer = newBuffer;

                    while (buffer.length >= PIECE_SIZE) {
                        const chunkToHash = buffer.slice(0, PIECE_SIZE);
                        const hash = await calculateSHA256(chunkToHash.buffer);
                        pieceHashes.push(hash);
                        buffer = buffer.slice(PIECE_SIZE);
                    }
                }

                const metadata = {
                    fileId: crypto.randomUUID(),
                    fileName: fileData.name,
                    fileSize: fileData.size,
                    fileType: fileData.type,
                    pieceHashes: pieceHashes
                };
                
                self.postMessage({ status: 'complete', metadata: metadata, tempId: tempId, intent: intent });
            };
        `;

    const blob = new Blob([workerCode], {type: 'application/javascript'});
    state.fileWorker = new Worker(URL.createObjectURL(blob));

    state.fileWorker.onmessage = async (event) => {
        const {status, metadata, tempId, intent} = event.data;
        if (status === 'complete') {
            const tempFileRef = state.localFiles.get(tempId);
            if (!tempFileRef) {
                console.error("Could not find original file reference for", tempId);
                return;
            }
            state.localFiles.delete(tempId);
            state.localFiles.set(metadata.fileId, {file: tempFileRef.file, metadata});
            state.localFileMetadata.set(metadata.fileId, metadata);

            const messageId = crypto.randomUUID();
            const messageType = intent === 'video' ? 'video_announce' : 'file_announce';
            
            const liteMetadata = {
                fileId: metadata.fileId,
                fileName: metadata.fileName,
                fileSize: metadata.fileSize,
                fileType: metadata.fileType,
                pieceCount: metadata.pieceHashes.length
            };

            let messagePayload = {
                type: messageType,
                metadata: liteMetadata,
                id: messageId,
                nickname: state.myNickname,
                realAddress: state.myRealAddress
            };
            
            // Flag the message ID before publishing to ignore the network echo.
            state.pendingSentMessages.add(messageId);

            try {
                const password = state.roomPasswords.get(state.currentRoomId);
                const currentRoomSettings = state.roomSettings.get(state.currentRoomId);
                let finalPayload;

                if (currentRoomSettings && currentRoomSettings.isPFS) {
                    if (state.currentEpochKey) {
                        const encrypted = await cryptoUtils.encryptMessage(cryptoUtils.textEncoder.encode(JSON.stringify(messagePayload)), state.currentEpochKey);
                        finalPayload = { roomId: state.currentRoomId, type: 'pfs_encrypted', epochId: state.currentEpochId, ...encrypted };
                    } else {
                        ui.showCustomAlert('Error', 'Cannot send file before secure session is established.');
                        state.pendingSentMessages.delete(messageId); // Clean up flag on failure
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

            } catch (error) {
                ui.showCustomAlert('Error', `Failed to announce file ${metadata.fileName}.`);
                const tempElement = document.getElementById(tempId);
                if (tempElement) tempElement.querySelector('.message-content').innerHTML = `<span class="text-red-500">Send failed</span>`;
                state.pendingSentMessages.delete(messageId); // Clean up flag on failure
                return;
            }

            const tempElement = document.getElementById(tempId);
            if (tempElement) {
                tempElement.id = `msg-${messageId}`;
                tempElement.dataset.sessionId = state.myPublisherId;

                const { fileName, fileSize } = metadata;
                let finalContentHTML = '';

                if (intent === 'video') {
                    const previewVideo = tempElement.querySelector('video');
                    if (previewVideo) {
                        const localUrl = previewVideo.src;
                        finalContentHTML = `
                            <div class="relative">
                                <video controls class="max-w-xs rounded-md" src="${localUrl}"></video>
                                <div class="absolute top-2 left-2 bg-black bg-opacity-60 text-white text-xs rounded-md px-2 py-1 flex items-center">
                                    <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 animate-pulse mr-2" viewBox="0 0 20 20" fill="currentColor"><path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" /></svg>
                                    <span>Seeding</span>
                                </div>
                            </div>`;
                    }
                } else {
                    finalContentHTML = `
                        <div class="file-container">
                            <div>
                                <div class="font-semibold">${utils.sanitizeHTML(fileName)}</div>
                                <div class="text-xs text-gray-400">${(fileSize / 1024 / 1024).toFixed(2)} MB</div>
                            </div>
                            <button class="file-button flex items-center justify-center gap-2" data-file-id="${metadata.fileId}" disabled>
                                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 animate-pulse" viewBox="0 0 20 20" fill="currentColor"><path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" /></svg>
                                <span>Seeding</span>
                            </button>
                        </div>`;
                }
                
                const createUserInfoHeaderHTML = (sessionId, helpers) => {
                    const userColor = helpers.getUserColor(sessionId); const displayName = helpers.getDisplayName(sessionId); const isVerified = helpers.verifiedRealAddresses.has(sessionId); const hasNick = helpers.getNickname(sessionId) !== null; let formattedId = ''; if (hasNick && isVerified) { const realAddress = helpers.userRealAddresses.get(sessionId); if (realAddress) { formattedId = `(${realAddress.slice(0, 6)}...${realAddress.slice(-4)})`; } } return `<div class="user-info-header text-xs font-semibold break-words"><span style="color: ${userColor};">${displayName}</span> ${isVerified ? `<span class="verification-seal cursor-pointer">✅</span>` : ''} ${formattedId ? `<span class="font-mono text-gray-500 text-xs ml-2">${formattedId}</span>` : ''}</div>`;
                };
                const createMessageTimestampHTML = (timestamp, isHistorical, isOwn) => {
                    const time = new Date(timestamp).toLocaleTimeString(); const seal = isHistorical ? '🕒' : '🛡️'; const sealType = isHistorical ? 'historical' : 'live'; const alignmentClass = isOwn ? 'text-right' : 'text-left'; return `<div class="message-timestamp ${alignmentClass}">${time} <span class="message-seal cursor-pointer" data-seal-type="${sealType}">${seal}</span></div>`;
                };

                const helpers = { getDisplayName: utils.getDisplayName, getUserColor: utils.getUserColor, getNickname: utils.getNickname, verifiedRealAddresses: state.verifiedRealAddresses, userRealAddresses: state.userRealAddresses };
                tempElement.innerHTML = `
                    <div class="message-bubble">
                        <div class="flex justify-between items-center">${createUserInfoHeaderHTML(state.myPublisherId, helpers)}</div>
                        <div class="message-content">${finalContentHTML}</div>
                        ${createMessageTimestampHTML(Date.now(), false, true)}
                        <div class="message-actions">
                            <div class="reply-button" data-message-id="${messageId}" title="Reply">↩️</div>
                            <div class="react-button" data-message-id="${messageId}" title="React">😀</div>
                        </div>
                    </div>
                    <div class="reactions-container" data-reactions-for="${messageId}"></div>
                `;
                const standardizedMessage = { type: messageType, metadata: liteMetadata, id: messageId, timestamp: Date.now(), userId: state.myPublisherId };
                state.lastMessages.push(standardizedMessage);
                if (state.lastMessages.length > config.MAX_MESSAGES) state.lastMessages.shift();
            }
        }
    };

    state.fileWorker.onerror = (error) => {
        console.error("Error in file worker:", error);
        ui.showCustomAlert('Processing Error', 'Could not process the file.');
    };
}
