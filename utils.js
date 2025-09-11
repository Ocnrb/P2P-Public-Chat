// utils.js

import { state } from './state.js';
import * as config from './config.js';

export function sanitizeHTML(str) {
    if (!str) return '';
    // DOMPurify is loaded from the HTML script tag, so it's a global
    return DOMPurify.sanitize(str, { ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'br'] });
}

export function getNickname(sessionId) {
    const realAddress = state.userRealAddresses.get(sessionId);
    if (realAddress) {
        return state.userNicknames.get(realAddress) || null;
    }
    return state.userNicknames.get(sessionId) || null;
}

export function getDisplayName(sessionId) {
    const nickname = getNickname(sessionId);
    if (nickname) return sanitizeHTML(nickname);

    const realAddress = state.userRealAddresses.get(sessionId);
    if (realAddress) {
        return `${realAddress.slice(0, 6)}...${realAddress.slice(-4)}`;
    }
    return `${sessionId.slice(0, 6)}...${sessionId.slice(-4)}`;
}

export function getColorKey(sessionId) {
    return state.userRealAddresses.get(sessionId) || sessionId;
}

export function getUserColor(userId) {
    const colorKey = getColorKey(userId);
    if (state.userColors.has(colorKey)) {
        return state.userColors.get(colorKey);
    }
    let hash = 0;
    for (let i = 0; i < colorKey.length; i++) {
        hash = colorKey.charCodeAt(i) + ((hash << 5) - hash);
    }
    const h = hash % 360;
    const color = `hsl(${h}, 80%, 70%)`;
    state.userColors.set(colorKey, color);
    return color;
}

export async function sha256FromArrayBuffer(buffer) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export function fileToBase64(file, callback) {
    const reader = new FileReader();
    reader.onload = (e) => callback(e.target.result);
    reader.onerror = (error) => console.error('File reading error:', error);
    reader.readAsDataURL(file);
}

export function resizeImage(file, callback) {
    fileToBase64(file, (base64) => {
        const img = new Image();
        img.onload = () => {
            if (img.width <= config.IMAGE_MAX_WIDTH) {
                callback(base64);
                return;
            }
            const canvas = document.createElement('canvas');
            const scale = config.IMAGE_MAX_WIDTH / img.width;
            canvas.width = config.IMAGE_MAX_WIDTH;
            canvas.height = img.height * scale;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            callback(canvas.toDataURL('image/jpeg', 0.7));
        };
        img.src = base64;
    });
}