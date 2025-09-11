// ui.js

import * as dom from './dom.js';
import * as config from './config.js';

// Note: Many functions now receive state (e.g., myPublisherId, activeUsers) 
// and helper functions (e.g., getDisplayName) as parameters.
// This makes the UI module more self-contained.

export function showCustomAlert(title, message) {
    dom.customAlertTitle.textContent = title;
    dom.customAlertMessage.textContent = message;
    dom.customAlertModal.classList.remove('hidden');
}

export function setLoginModalState(state) {
    if (state === 'loading') {
        dom.loginContent.classList.add('hidden');
        dom.loadingContent.classList.remove('hidden');
    } else {
        dom.loginContent.classList.remove('hidden');
        dom.loadingContent.classList.add('hidden');
    }
    dom.loginModal.classList.remove('hidden');
}

function createUserInfoHeaderHTML(sessionId, getDisplayName, getUserColor, getNickname, verifiedRealAddresses, userRealAddresses) {
    const userColor = getUserColor(sessionId);
    const displayName = getDisplayName(sessionId); // This is sanitized by getDisplayName
    const isVerified = verifiedRealAddresses.has(sessionId);
    const hasNick = getNickname(sessionId) !== null;

    let formattedId = '';
    if (hasNick && isVerified) {
        const realAddress = userRealAddresses.get(sessionId);
        if (realAddress) {
            formattedId = `(${realAddress.slice(0, 6)}...${realAddress.slice(-4)})`;
        }
    }

    return `
        <div class="user-info-header text-xs font-semibold break-words">
            <span style="color: ${userColor};">${displayName}</span>
            ${isVerified ? `<span class="verification-seal cursor-pointer">✅</span>` : ''}
            ${formattedId ? `<span class="font-mono text-gray-500 text-xs ml-2">${formattedId}</span>` : ''}
        </div>
    `;
}

function createMessageTimestampHTML(timestamp, isHistorical, isOwn) {
    const time = new Date(timestamp).toLocaleTimeString();
    const seal = isHistorical ? '🕒' : '🛡️';
    const sealType = isHistorical ? 'historical' : 'live';
    const alignmentClass = isOwn ? 'text-right' : 'text-left';

    return `
        <div class="message-timestamp ${alignmentClass}">${time} 
            <span class="message-seal cursor-pointer" data-seal-type="${sealType}">${seal}</span>
        </div>`;
}

export function addMessageToUI(msgDiv, isHistorical) {
    const allMessages = dom.messagesContainer.querySelectorAll('.message-entry');
    let referenceNode = null;
    const newTimestamp = parseInt(msgDiv.dataset.timestamp, 10);

    for (const child of allMessages) {
        const childTimestamp = parseInt(child.dataset.timestamp, 10);
        if (childTimestamp > newTimestamp) {
            referenceNode = child;
            break;
        }
    }

    dom.messagesContainer.insertBefore(msgDiv, referenceNode);

    if (!isHistorical) {
        dom.messagesContainer.scrollTop = dom.messagesContainer.scrollHeight;
    }

    while (dom.messagesContainer.children.length > config.MAX_MESSAGES) {
        dom.messagesContainer.removeChild(dom.messagesContainer.firstChild);
    }
}

export function createMessageElement(message, metadata, isHistorical, helpers) {
    const { myPublisherId, getDisplayName, getUserColor, getNickname, verifiedRealAddresses, userRealAddresses, sanitizeHTML } = helpers;

    const messageId = message.id || metadata.timestamp;
    const isOwnMessage = metadata.publisherId === myPublisherId;

    let msgDiv = document.createElement('div');
    msgDiv.id = `msg-${messageId}`;
    msgDiv.className = 'message-entry';
    msgDiv.dataset.sessionId = metadata.publisherId;
    msgDiv.dataset.timestamp = metadata.timestamp;
    msgDiv.classList.add(isOwnMessage ? 'own-message' : 'other-message');

    let contentHTML = '';
    let replyHTML = '';

    if (message.replyToMessageId) {
        replyHTML = `
            <div class="reply-snippet" data-scroll-to="${message.replyToMessageId}">
                <div class="font-bold text-xs" style="color: ${getUserColor(message.replyToUser)};">Replying to ${getDisplayName(message.replyToUser)}</div>
                <div class="text-xs text-gray-400 truncate">${sanitizeHTML(message.replyToContent)}</div>
            </div>
        `;
    }

    if (message.type === 'decryption_failed') {
        contentHTML = `<div class="text-xs italic text-gray-500">🔒 Encrypted message. Incorrect password.</div>`;
    } else if (message.type === 'decryption_failed_epoch_mismatch') {
        contentHTML = `<div class="text-xs italic text-gray-500">🛡️ Outdated message from a previous security session.</div>`;
    } else if (message.type === 'image') {
        contentHTML = `<div class="text-xs italic text-gray-500" data-image-id="${message.imageId}">Loading image...</div>`;
    } else if (message.type === 'file_announce' || message.type === 'video_announce') {
        const {fileId, fileName, fileSize} = message.metadata;
        const isOwnFile = metadata.publisherId === myPublisherId;
        const isVideo = message.type === 'video_announce';
        const senderButton = `<button class="file-button flex items-center justify-center gap-2" data-file-id="${fileId}" disabled><svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 animate-pulse" viewBox="0 0 20 20" fill="currentColor"><path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" /></svg><span>Seeding</span></button>`;
        const playButton = `<button class="file-button flex items-center justify-center gap-2" data-action="start-download" data-file-id="${fileId}"><svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clip-rule="evenodd" /></svg><span>Play</span></button>`;
        const downloadButton = `<button class="file-button" data-action="start-download" data-file-id="${fileId}">Download</button>`;
        const receiverInteractionHTML = `<div id="file-interaction-${fileId}" class="flex flex-col items-start gap-y-1 mt-2">${isVideo ? playButton : downloadButton}<span class="seeder-count text-xs text-gray-500" data-file-id="${fileId}"></span></div>`;
        contentHTML = `<div class="file-container flex flex-col items-start gap-y-2"><div><div class="font-semibold">${sanitizeHTML(fileName)}</div><div class="text-xs text-gray-400">${(fileSize / 1024 / 1024).toFixed(2)} MB</div></div>${isOwnFile ? senderButton : receiverInteractionHTML}</div>`;
    } else if (message.type === 'start_stream') {
        if (message.streamType === 'audio') {
            msgDiv.classList.add('message-entry-wide');
            contentHTML = `
                <div class="stream-container audio-stream-container">
                    <div class="flex items-center text-sm font-semibold">Live Audio <span class="live-indicator"></span></div>
                    <div class="audio-visualizer">
                        <div class="audio-bar"></div><div class="audio-bar"></div><div class="audio-bar"></div>
                        <div class="audio-bar"></div><div class="audio-bar"></div>
                    </div>
                </div>`;
        } else { // Default to video
            msgDiv.classList.add('message-entry-wide');
            contentHTML = `<div class="stream-container"><div class="flex items-center">Live <span class="live-indicator"></span></div><canvas id="stream-${message.streamId}" width="854" height="480" class="bg-black rounded-md w-full h-auto"></canvas><button class="fullscreen-btn" data-stream-id="${message.streamId}"><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-5h-4m0 0v4m0-4l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5h-4m0 0v-4m0 4l-5-5"></path></svg></button></div>`;
        }
    } else if (message.type === 'stop_stream') {
        contentHTML = `<div class="text-xs italic text-gray-500">Stream ended.</div>`;
    } else {
        contentHTML = sanitizeHTML(message.content || message.text || '');
    }

    msgDiv.innerHTML = `
        <div class="message-bubble">
            <div class="flex justify-between items-center">
                ${createUserInfoHeaderHTML(metadata.publisherId, getDisplayName, getUserColor, getNickname, verifiedRealAddresses, userRealAddresses)}
            </div>
            ${replyHTML}
            <div class="message-content">${contentHTML}</div>
            ${createMessageTimestampHTML(metadata.timestamp, isHistorical, isOwnMessage)}
            <div class="message-actions">
                <div class="reply-button" data-message-id="${messageId}" title="Reply">↩️</div>
                <div class="react-button" data-message-id="${messageId}" title="React">😀</div>
            </div>
        </div>
        <div class="reactions-container" data-reactions-for="${messageId}"></div>
    `;

    return msgDiv;
}


export function updateUserList(activeUsers, verifiedRealAddresses, getDisplayName, getUserColor) {
    dom.usersCounter.textContent = activeUsers.size;
    dom.usersList.innerHTML = '';
    if (activeUsers.size > 0) {
        activeUsers.forEach((data, sessionId) => {
            const userColor = getUserColor(sessionId);
            const isVerified = verifiedRealAddresses.has(sessionId);
            const userItem = document.createElement('div');
            userItem.className = 'user-item';
            userItem.innerHTML = `<div class="user-dot"></div><span class="truncate" style="color: ${userColor};">${getDisplayName(sessionId)} ${isVerified ? '✅' : ''}</span>`;
            dom.usersList.appendChild(userItem);
        });
    } else {
        dom.usersList.innerHTML = '<div class="text-gray-400 text-sm text-center">No one online.</div>';
    }
}

export function updateReactionsUI(messageId, messageReactions, myPublisherId) {
    const container = document.querySelector(`[data-reactions-for="${messageId}"]`);
    if (!container) return;

    container.innerHTML = '';
    const reactions = messageReactions.get(messageId);
    if (reactions) {
        for (const [emoji, userIds] of Object.entries(reactions)) {
            if (userIds.length > 0) {
                const badge = document.createElement('div');
                badge.className = 'reaction-badge';
                badge.textContent = `${emoji} ${userIds.length}`;
                badge.dataset.emoji = emoji;
                badge.dataset.messageId = messageId;
                if (userIds.includes(myPublisherId)) {
                    badge.classList.add('user-reacted');
                }
                container.appendChild(badge);
            }
        }
    }
}

export function updateTypingIndicatorUI(typingUsers, getDisplayName) {
    const now = Date.now();
    const typingNames = [];
    for (const [userId, lastTyped] of typingUsers.entries()) {
        if (now - lastTyped < config.TYPING_INDICATOR_TIMEOUT) {
            typingNames.push(getDisplayName(userId));
        }
    }

    let indicator = document.getElementById('typing-indicator-bubble');

    if (typingNames.length === 0) {
        if (indicator) {
            indicator.remove();
        }
        return;
    }

    if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'typing-indicator-bubble';
        indicator.className = 'message-entry other-message';
        dom.messagesContainer.appendChild(indicator);
    }

    indicator.innerHTML = `
        <div class="message-bubble">
            <div class="message-content flex items-center">
                <span class="typing-dot"></span>
                <span class="typing-dot"></span>
                <span class="typing-dot"></span>
            </div>
        </div>
    `;

    dom.messagesContainer.scrollTop = dom.messagesContainer.scrollHeight;
}


export function updateRoomListUI(activeRooms, roomSettings) {
    dom.roomList.innerHTML = ''; // Clear the list

    const sortedRooms = [...activeRooms.keys()].sort((a, b) => {
        if (a === 'Lobby') return -1;
        if (b === 'Lobby') return 1;
        return a.localeCompare(b);
    });

    sortedRooms.forEach(roomId => {
        const roomData = activeRooms.get(roomId);
        const userCount = roomData.users.size;
        const currentRoomSettings = roomSettings.get(roomId) || {};
        const isPrivate = roomData.isPrivate || currentRoomSettings.isPFS;
        const isPFS = currentRoomSettings.isPFS;

        const lockIcon = isPrivate ? '🔒' : '';
        const securityIcon = isPFS ? '🛡️' : '';

        const roomItem = document.createElement('div');
        roomItem.className = 'bg-[#2a2a2a] p-3 rounded-lg flex justify-between items-center';
        roomItem.innerHTML = `
            <span class="font-semibold truncate pr-2">${roomId} ${lockIcon}${securityIcon}</span>
            <div class="flex items-center gap-x-3 flex-shrink-0">
                <span class="text-xs text-gray-400">${userCount} user(s)</span>
                <button class="join-room-btn bg-gray-600 hover:bg-gray-700 text-sm py-1 px-3 rounded-md" data-room-id="${roomId}" data-is-private="${isPrivate}">Join</button>
            </div>
        `;
        dom.roomList.appendChild(roomItem);
    });
}

export function updateUIVerification(sessionId, helpers) {
    const messagesToUpdate = document.querySelectorAll(`.message-entry[data-session-id="${sessionId}"]`);

    messagesToUpdate.forEach(msg => {
        const userInfoHeader = msg.querySelector('.user-info-header');
        if (userInfoHeader) {
            userInfoHeader.parentElement.innerHTML = createUserInfoHeaderHTML(sessionId, helpers.getDisplayName, helpers.getUserColor, helpers.getNickname, helpers.verifiedRealAddresses, helpers.userRealAddresses);
        }
    });
    updateUserList(helpers.activeUsers, helpers.verifiedRealAddresses, helpers.getDisplayName, helpers.getUserColor);
}

