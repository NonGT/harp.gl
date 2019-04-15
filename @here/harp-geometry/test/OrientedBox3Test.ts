/*
 * Copyright (C) 2017-2019 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

// tslint:disable:only-arrow-functions
//    Mocha discourages using arrow functions, see https://mochajs.org/#arrow-functions

import { assert } from "chai";
import { OrientedBox3 } from "../lib/OrientedBox3";

import * as THREE from "three";

import {
    EarthConstants,
    GeoCoordinates,
    sphereProjection,
    TileKey,
    TilingScheme,
    webMercatorTilingScheme
} from "@here/harp-geoutils";

/**
 * Visits the tile tree.
 *
 * @param accept The accepting function. The function must return false to stop the visit.
 * @param tilingScheme The tiling scheme.
 * @param tileKey The root tile key.
 */
function visit(
    tilingScheme: TilingScheme,
    accept: (tileKey: TileKey) => boolean,
    tileKey: TileKey = new TileKey(0, 0, 0)
) {
    if (!accept(tileKey)) {
        // stop visiting te subtree
        return;
    }

    // visit the sub tree.
    for (const childTileKey of tilingScheme.getSubTileKeys(tileKey)) {
        visit(tilingScheme, accept, childTileKey);
    }
}

class GlobeControls {
    readonly camera = new THREE.PerspectiveCamera();
    readonly projectionViewMatrix = new THREE.Matrix4();
    readonly frustum = new THREE.Frustum();

    constructor() {
        this.camera.up.set(0, 0, 1); // set the up vector
    }

    /**
     * Place the camera at the given position.
     *
     * @param geoPoint The position of the camera in geo coordinates.
     */
    set(geoPoint: GeoCoordinates) {
        if (geoPoint.altitude === undefined || geoPoint.altitude === 0) {
            throw new Error("invalid camera position.");
        }

        const pointOnSurface = new THREE.Vector3();

        sphereProjection.projectPoint(
            new GeoCoordinates(geoPoint.latitude, geoPoint.longitude),
            pointOnSurface
        );

        const normal = pointOnSurface.clone().normalize();

        // compute the camera position by adding a properly scaled
        // vector to the surface position.
        const cameraPosition = pointOnSurface.clone().addScaledVector(normal, geoPoint.altitude);

        // set the camera position.
        this.camera.position.copy(cameraPosition);

        // look at the center of the globe.
        this.camera.lookAt(new THREE.Vector3(0, 0, 0));

        this.camera.updateMatrixWorld(true);

        const bias = 100;

        // set the near and far plane.
        this.camera.far = cameraPosition.length();
        this.camera.near = this.camera.far - (EarthConstants.EQUATORIAL_RADIUS + bias);
        this.camera.updateProjectionMatrix();

        // compute the projectionView matrix.
        this.projectionViewMatrix.multiplyMatrices(
            this.camera.projectionMatrix,
            this.camera.matrixWorldInverse
        );

        // update the view frustum.
        this.frustum.setFromMatrix(this.projectionViewMatrix);
    }

    /**
     * Computes the list of the tiles interesting the view frustum.
     *
     * @param tilingScheme The tiling scheme.
     * @param level The storage level.
     */
    getVisibleTiles(tilingScheme: TilingScheme, level: number) {
        const visibleTiles: TileKey[] = [];

        const visitTile = (tileKey: TileKey) => {
            // get the geobox of the current tile.
            const geoBox = tilingScheme.getGeoBox(tileKey);

            // compute the world oriented bounding box of the tile.
            const obb = new OrientedBox3();
            sphereProjection.projectBox(geoBox, obb);

            // check for intersections with the view frustum.
            if (!obb.intersects(this.frustum)) {
                return false;
            }

            if (tileKey.level === level) {
                // add the tile to the list of the visible tiles.
                visibleTiles.push(tileKey);
            }

            // continue visiting the subtree if the tile's level is less than the requested level.
            return tileKey.level < level;
        };

        visit(tilingScheme, visitTile);

        return visibleTiles;
    }
}

describe("OrientedBox3", function() {
    const controls = new GlobeControls();

    controls.set(new GeoCoordinates(53.3, 13.4, 1000));

    const visibleTiles = controls.getVisibleTiles(webMercatorTilingScheme, 14);

    assert.equal(visibleTiles.length, 2);
});
