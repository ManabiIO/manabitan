/* SPDX-License-Identifier: GPL-3.0-or-later */
import type {Media} from '../../types/ext/dictionary-database';
import {WebRuntimeError} from './protocol.js';

export const MAX_WEB_IMAGE_BYTES = 32 * 1024 * 1024;

/**
 * Never structured-clone arbitrary imported media into the Reader page.
 * @param media
 */
export function webMediaResponse(media: Media | undefined): {content: ArrayBuffer, mediaType: string} | null {
    if (!media || !/^image\/(?:png|jpeg|webp|gif|avif|svg\+xml)$/.test(media.mediaType)) {return null;}
    if (media.content.byteLength > MAX_WEB_IMAGE_BYTES) {
        throw new WebRuntimeError('image_too_large', 'Dictionary image exceeds display size limit');
    }
    if (media.content.byteLength === 0) {return null;}
    return {content: media.content, mediaType: media.mediaType};
}
