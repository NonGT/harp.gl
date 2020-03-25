/*
 * Copyright (C) 2020 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */
import * as THREE from "three";

interface RequestHeaders {
    [field: string]: string;
}

/**
 * A texture loader that also supports request headers(e.g. Authorization)
 */
export class TextureLoader extends THREE.TextureLoader {
    /**
     * Request headers
     */
    requestHeaders?: RequestHeaders;

    /**
     * Sets request headers
     * @param headers
     */
    setRequestHeaders(requestHeaders: RequestHeaders | undefined): void {
        this.requestHeaders = requestHeaders;
    }

    load(
        url: string,
        onLoad?: (texture: THREE.Texture) => void,
        onProgress?: (event: ProgressEvent) => void,
        onError?: (event: ErrorEvent) => void
    ): THREE.Texture {
        // Use normal texture loader if no request header is set
        if (this.requestHeaders === undefined) {
            return super.load(url, onLoad, onProgress, onError);
        }

        if (this.path !== undefined) {
            url = this.path + url;
        }
        url = this.manager.resolveURL(url);

        // Load image with fetch API if request header is set
        const texture = new THREE.Texture();

        this.manager.itemStart(url);
        fetch(url, {
            headers: this.requestHeaders,
            mode: this.crossOrigin !== undefined ? "cors" : "no-cors"
        })
            .then(response => {
                return response.blob();
            })
            .then(blob => {
                return this.loadImageFromBlob(blob);
            })
            .then(image => {
                texture.image = image;
                // JPEGs can't have an alpha channel, so memory can be saved by storing them as RGB.
                const isJPEG =
                    url.search(/\.jpe?g($|\?)/i) > 0 || url.search(/^data\:image\/jpeg/) === 0;
                texture.format = isJPEG ? THREE.RGBFormat : THREE.RGBAFormat;
                texture.needsUpdate = true;

                if (onLoad !== undefined) {
                    onLoad(texture);
                }
                this.manager.itemEnd(url);
            })
            .catch(error => {
                if (onError !== undefined) {
                    onError(error);
                }
                this.manager.itemError(url);
                this.manager.itemEnd(url);
            });

        return texture;
    }

    private loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
        return new Promise<HTMLImageElement>((resolve, reject) => {
            try {
                const image = document.createElementNS(
                    "http://www.w3.org/1999/xhtml",
                    "img"
                ) as HTMLImageElement;
                image.src = URL.createObjectURL(blob);
                image.addEventListener("load", () => resolve(image));
                image.addEventListener("error", error => reject(error));
            } catch (error) {
                reject(error);
            }
        });
    }
}
