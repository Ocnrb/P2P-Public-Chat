// file-transfer.js (Corrigido)

import { state } from './state.js';
import * as config from './config.js';
import * as cryptoUtils from './cryptoUtils.js'; // CAMINHO E NOME CORRIGIDOS
import * as ui from './ui.js';
import * as db from './db.js';
import * as utils from './utils.js';

// Internal functions (not exported, unless needed by other modules)
async function announceFileSource(fileId) {
    if (!state.streamr) return;
    try {
        await state.streamr.publish(config.FILE_META_STREAM_ID, {
            roomId: state.currentRoomId,
            type: 'source_announce',
            fileId: fileId,
        });
    } catch (err) {
        console.error(`Failed to announce source for ${fileId}`, err);
    }
}

async function requestPiece(fileId, pieceIndex, seederId) {
    if (!state.streamr) return;
    const transfer = state.incomingFiles.get(fileId);
    if (!transfer || transfer.pieceStatus[pieceIndex] !== 'pending') return;
    transfer.pieceStatus[pieceIndex] = 'requested';

    const timeoutId = setTimeout(() => {
        if (transfer.pieceStatus[pieceIndex] === 'requested') {
            transfer.pieceStatus[pieceIndex] = 'pending';
            transfer.requestsInFlight.delete(pieceIndex);
            manageDownload(fileId);
        }
    }, config.PIECE_REQUEST_TIMEOUT);

    transfer.requestsInFlight.set(pieceIndex, {seederId, timeoutId});

    try {
        await state.streamr.publish(config.FILE_STREAM_ID, {
            roomId: state.currentRoomId, type: 'piece_request', fileId, pieceIndex, targetSeederId: seederId
        });
    } catch (error) {
        transfer.pieceStatus[pieceIndex] = 'pending';
        clearTimeout(timeoutId);
        transfer.requestsInFlight.delete(pieceIndex);
        manageDownload(fileId);
    }
}

async function sendPiece(fileId, pieceIndex) {
    if (!state.streamr) return;
    try {
        const {file} = state.localFiles.get(fileId);
        if (!file) return;

        const start = pieceIndex * config.PIECE_SIZE;
        const end = Math.min(start + config.PIECE_SIZE, file.size);
        const pieceBlob = file.slice(start, end);
        const pieceBuffer = await pieceBlob.arrayBuffer();

        const password = state.roomPasswords.get(state.currentRoomId);
        const currentRoomSettings = state.roomSettings.get(state.currentRoomId);
        let payload;

        if (currentRoomSettings && currentRoomSettings.isPFS && state.currentEpochKey) {
            const encrypted = await cryptoUtils.encryptMessage(pieceBuffer, state.currentEpochKey);
            payload = { roomId: state.currentRoomId, type: 'pfs_encrypted_piece', fileId, pieceIndex, epochId: state.currentEpochId, ...encrypted };
        } else if (password) {
            const key = await cryptoUtils.deriveKeyFromPassword(password, state.currentRoomId);
            const encrypted = await cryptoUtils.encryptMessage(pieceBuffer, key);
            payload = { roomId: state.currentRoomId, type: 'file_piece', fileId, pieceIndex, encryptedData: encrypted.content, iv: encrypted.iv };
        } else {
            payload = {roomId: state.currentRoomId, type: 'file_piece', fileId, pieceIndex, data: cryptoUtils.arrayBufferToBase64(pieceBuffer)};
        }
        await state.streamr.publish(config.FILE_STREAM_ID, payload);
    } catch (error) {}
}

async function assembleAndSeedFile(fileId) {
    const transfer = state.incomingFiles.get(fileId);
    if (!transfer) return;
    try {
        const newFile = await db.getAllPiecesAsFile(fileId, transfer.metadata.fileName, transfer.metadata.fileType);
        await db.clearFile(fileId);
        state.localFiles.set(fileId, {file: newFile, metadata: transfer.metadata});
        state.localFileMetadata.set(fileId, transfer.metadata);
        state.incomingFiles.delete(fileId);

        const interactionContainer = document.getElementById(`file-interaction-${fileId}`);
        if (interactionContainer && transfer.metadata.fileType.startsWith('video/')) {
            const url = URL.createObjectURL(newFile);
            interactionContainer.innerHTML = `<div class="relative"><video controls class="max-w-xs rounded-md" src="${url}"></video><div class="absolute top-2 left-2 bg-black bg-opacity-60 text-white text-xs rounded-md px-2 py-1 flex items-center"><svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 animate-pulse mr-2" viewBox="0 0 20 20" fill="currentColor"><path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" /></svg><span>Seeding</span></div></div>`;
        } else {
            const url = URL.createObjectURL(newFile);
            const a = document.createElement('a');
            a.href = url; a.download = newFile.name; document.body.appendChild(a); a.click(); window.URL.revokeObjectURL(url); a.remove();
            if (interactionContainer) {
                interactionContainer.innerHTML = `<button class="file-button flex items-center justify-center gap-2" data-file-id="${fileId}" disabled><svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 animate-pulse" viewBox="0 0 20 20" fill="currentColor"><path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" /></svg><span>Seeding</span></button>`;
            }
        }
    } catch (error) {
        ui.showCustomAlert("Download Error", "Could not assemble file after download.");
    }
}

function manageDownload(fileId) {
    const transfer = state.incomingFiles.get(fileId);
    if (!transfer || !transfer.pieceStatus) return;
    const seeders = Array.from(state.fileSeeders.get(fileId) || []);
    if (seeders.length === 0) return;

    let seederIndex = 0;
    while (transfer.requestsInFlight.size < config.MAX_CONCURRENT_REQUESTS) {
        const nextPieceIndex = transfer.pieceStatus.findIndex(s => s === 'pending');
        if (nextPieceIndex === -1) break;
        const seederId = seeders[seederIndex % seeders.length];
        requestPiece(fileId, nextPieceIndex, seederId);
        seederIndex++;
    }
}

async function requestFullMetadata(fileId) {
    if (!state.streamr) return;
    state.incomingFileMetadata.set(fileId, { chunks: new Map(), totalChunks: -1 });
    try {
        await state.streamr.publish(config.FILE_META_STREAM_ID, {
            roomId: state.currentRoomId, type: 'metadata_request', fileId: fileId,
        });
    } catch (err) {
        console.error(`Failed to request metadata for ${fileId}`, err);
    }
}

function initiateFilePieceDownload(fileId) {
    const transfer = state.incomingFiles.get(fileId);
    if (!transfer) return;

    const seeders = state.fileSeeders.get(fileId);
    if (!seeders || seeders.size === 0) {
        const interactionContainer = document.getElementById(`file-interaction-${fileId}`);
        if (interactionContainer) {
            interactionContainer.innerHTML = `<span class="text-xs text-yellow-500">No seeders. Retrying...</span>`;
            setTimeout(() => requestFileSources(fileId), 5000);
        }
        return;
    }

    const interactionContainer = document.getElementById(`file-interaction-${fileId}`);
    let progressText;
    try {
        if (transfer.metadata.fileSize < config.MAX_BLOB_ASSEMBLY_SIZE) {
            transfer.useIndexedDB = true;
            progressText = 'Receiving... 0%';
        } else {
            const fileStream = streamSaver.createWriteStream(transfer.metadata.fileName, {size: transfer.metadata.fileSize});
            transfer.writer = fileStream.getWriter();
            progressText = 'Saving to disk... 0%';
        }
    } catch (error) {
        ui.showCustomAlert('Download Error', 'Could not start download. Browser extension may be interfering.');
        if (interactionContainer) {
            const buttonHTML = `<button class="file-button" data-action="start-download" data-file-id="${fileId}">Download</button>`;
            interactionContainer.innerHTML = `${buttonHTML}<span class="seeder-count text-xs text-gray-500" data-file-id="${fileId}"></span>`;
        }
        return;
    }

    if (interactionContainer) {
        interactionContainer.innerHTML = `
            <div class="flex items-center gap-2">
                <span class="progress-text text-xs text-gray-400">${progressText}</span>
                <button class="cancel-download-btn text-gray-400 hover:text-white" title="Cancel" data-action="cancel-download" data-file-id="${fileId}">
                    <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"></path></svg>
                </button>
            </div>`;
    }
    manageDownload(fileId);
}

// Exported functions
export async function requestFileSources(fileId) {
    if (!state.streamr) return;
    state.fileSeeders.set(fileId, new Set());
    try {
        await state.streamr.publish(config.FILE_META_STREAM_ID, {
            roomId: state.currentRoomId,
            type: 'source_request',
            fileId: fileId,
        });
    } catch (err) {
        console.error(`Failed to request sources for ${fileId}`, err);
    }
}

export function startDownload(fileId) {
    const transfer = state.incomingFiles.get(fileId);
    if (!transfer) return;

    if (transfer.metadata && transfer.metadata.pieceHashes) {
        initiateFilePieceDownload(fileId);
    } else {
        requestFullMetadata(fileId);
        const interactionContainer = document.getElementById(`file-interaction-${fileId}`);
        if (interactionContainer) {
            interactionContainer.innerHTML = `<div class="flex items-center gap-2"><div class="spinner"></div><span class="text-xs text-gray-400">Fetching metadata...</span></div>`;
        }
    }
}

export async function cancelDownload(fileId) {
    const transfer = state.incomingFiles.get(fileId);
    if (transfer) {
        if (transfer.writer) {
            transfer.writer.abort();
            transfer.writer = null;
        }
        if (transfer.useIndexedDB) await db.clearFile(fileId);
        transfer.requestsInFlight.forEach(({timeoutId}) => clearTimeout(timeoutId));
        state.incomingFiles.delete(fileId);

        const interactionContainer = document.getElementById(`file-interaction-${fileId}`);
        if (interactionContainer) {
            const buttonHTML = `<button class="file-button" data-action="start-download" data-file-id="${fileId}">Download</button>`;
            interactionContainer.innerHTML = `${buttonHTML}<span class="seeder-count text-xs text-gray-500" data-file-id="${fileId}"></span>`;
        }
    }
}

export async function handleFileStreamMessage(message, metadata) {
    if (message.roomId !== state.currentRoomId) return;
    try {
        if (message.type === 'piece_request') {
            if (state.localFiles.has(message.fileId) && message.targetSeederId === state.myPublisherId) {
                await sendPiece(message.fileId, message.pieceIndex);
            }
        } else if (message.type === 'file_piece' || message.type === 'pfs_encrypted_piece') {
            if (metadata.publisherId === state.myPublisherId) return;

            const {fileId, pieceIndex} = message;
            const transfer = state.incomingFiles.get(fileId);
            if (!transfer || !transfer.metadata.pieceHashes || transfer.pieceStatus[pieceIndex] !== 'requested') return;

            let pieceBuffer;
            const currentRoomSettings = state.roomSettings.get(state.currentRoomId);

            if (message.type === 'pfs_encrypted_piece' && currentRoomSettings && currentRoomSettings.isPFS) {
                if (state.currentEpochKey && message.epochId === state.currentEpochId) {
                    pieceBuffer = await cryptoUtils.decryptMessage(message.content, state.currentEpochKey, message.iv);
                }
            } else if (message.encryptedData) {
                const password = state.roomPasswords.get(state.currentRoomId);
                if (password) {
                    const key = await cryptoUtils.deriveKeyFromPassword(password, state.currentRoomId);
                    pieceBuffer = await cryptoUtils.decryptMessage(message.encryptedData, key, message.iv);
                }
            } else if (!currentRoomSettings || !currentRoomSettings.isPFS) {
                pieceBuffer = cryptoUtils.base64ToArrayBuffer(message.data);
            }

            if (!pieceBuffer) {
                transfer.pieceStatus[pieceIndex] = 'pending';
                clearTimeout(transfer.requestsInFlight.get(pieceIndex).timeoutId);
                transfer.requestsInFlight.delete(pieceIndex);
                manageDownload(fileId);
                return;
            }

            const receivedHash = await utils.sha256FromArrayBuffer(pieceBuffer);
            if (receivedHash !== transfer.metadata.pieceHashes[pieceIndex]) {
                transfer.pieceStatus[pieceIndex] = 'pending';
                clearTimeout(transfer.requestsInFlight.get(pieceIndex).timeoutId);
                transfer.requestsInFlight.delete(pieceIndex);
                manageDownload(fileId);
                return;
            }

            clearTimeout(transfer.requestsInFlight.get(pieceIndex).timeoutId);
            transfer.requestsInFlight.delete(pieceIndex);

            const bytes = new Uint8Array(pieceBuffer);

            if (transfer.useIndexedDB) {
                await db.savePiece(fileId, pieceIndex, bytes);
            } else if (transfer.writer) {
                await transfer.writer.write(bytes);
            }

            transfer.pieceStatus[pieceIndex] = 'done';
            transfer.receivedCount++;

            const progress = Math.round((transfer.receivedCount / transfer.metadata.pieceHashes.length) * 100);
            const receivedMB = (transfer.receivedCount * config.PIECE_SIZE / 1024 / 1024).toFixed(2);
            const totalMB = (transfer.metadata.fileSize / 1024 / 1024).toFixed(2);
            const progressElement = document.querySelector(`#file-interaction-${fileId} .progress-text`);
            if (progressElement) {
                progressElement.textContent = `Receiving... ${progress}% (${receivedMB}MB / ${totalMB}MB)`;
            }

            if (transfer.receivedCount === transfer.metadata.pieceHashes.length) {
                if (transfer.useIndexedDB) {
                    assembleAndSeedFile(fileId);
                } else if (transfer.writer) {
                    await transfer.writer.close();
                    transfer.writer = null;
                    const interactionContainer = document.getElementById(`file-interaction-${fileId}`);
                    if (interactionContainer) {
                        interactionContainer.innerHTML = `<span class="text-green-400 text-xs">Download Complete</span>`;
                    }
                }
            } else {
                manageDownload(fileId);
            }
        }
    } catch (error) {
        console.error("Error in handleFileStreamMessage:", error);
    }
}

export async function handleFileMetaMessage(message, metadata) {
    if (message.roomId !== state.currentRoomId) return;

    if (message.type === 'source_request') {
        if (state.localFiles.has(message.fileId) && metadata.publisherId !== state.myPublisherId) {
            await announceFileSource(message.fileId);
        }
    } else if (message.type === 'source_announce') {
        const seeders = state.fileSeeders.get(message.fileId);
        if (seeders) {
            seeders.add(metadata.publisherId);
            const seederCountElement = document.querySelector(`.seeder-count[data-file-id="${message.fileId}"]`);
            if (seederCountElement) {
                seederCountElement.textContent = `(${seeders.size} seeders)`;
            }
        }
    } else if (message.type === 'metadata_request') {
        if (state.localFileMetadata.has(message.fileId) && metadata.publisherId !== state.myPublisherId) {
            const fullMetadata = state.localFileMetadata.get(message.fileId);
            const hashes = fullMetadata.pieceHashes;
            const totalChunks = Math.ceil(hashes.length / config.METADATA_CHUNK_SIZE);

            for (let i = 0; i < totalChunks; i++) {
                const chunk = hashes.slice(i * config.METADATA_CHUNK_SIZE, (i + 1) * config.METADATA_CHUNK_SIZE);
                try {
                    await state.streamr.publish(config.FILE_META_STREAM_ID, {
                        roomId: state.currentRoomId,
                        type: 'metadata_piece',
                        fileId: message.fileId,
                        chunkIndex: i,
                        totalChunks: totalChunks,
                        hashes: chunk
                    });
                } catch (err) {
                    console.error(`Failed to send metadata chunk ${i} for ${message.fileId}`, err);
                }
            }
        }
    } else if (message.type === 'metadata_piece') {
        if (metadata.publisherId === state.myPublisherId) return;

        const collector = state.incomingFileMetadata.get(message.fileId);
        if (collector && !collector.chunks.has(message.chunkIndex)) {
            collector.chunks.set(message.chunkIndex, message.hashes);
            collector.totalChunks = message.totalChunks;

            if (collector.chunks.size === collector.totalChunks) {
                const allHashes = [];
                for (let i = 0; i < collector.totalChunks; i++) {
                    allHashes.push(...collector.chunks.get(i));
                }
                const transfer = state.incomingFiles.get(message.fileId);
                if (transfer) {
                    transfer.metadata.pieceHashes = allHashes;
                    transfer.pieceStatus = new Array(allHashes.length).fill('pending');
                    state.incomingFileMetadata.delete(message.fileId);
                    initiateFilePieceDownload(message.fileId);
                }
            }
        }
    }
}