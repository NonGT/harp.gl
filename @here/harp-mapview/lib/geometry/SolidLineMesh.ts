/*
 * Copyright (C) 2020 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

import { hasDisplacementFeature, SolidLineMaterial } from "@here/harp-materials";
import { assert } from "@here/harp-utils";
import * as THREE from "three";
import { DisplacedBufferAttribute } from "./DisplacedBufferAttribute";
import { DisplacedBufferGeometry, DisplacementRange } from "./DisplacedBufferGeometry";

const tmpSphere = new THREE.Sphere();
const tmpInverseMatrix = new THREE.Matrix4();
const tmpRay = new THREE.Ray();
const tmpBox1 = new THREE.Box3();
const tmpBox2 = new THREE.Box3();
const tmpVector1 = new THREE.Vector3();
const tmpVector2 = new THREE.Vector3();
const tmpVector3 = new THREE.Vector3();
const tmpVector4 = new THREE.Vector3();
const tmpNormal = new THREE.Vector3();

function computeBoundingSphere(
    position: THREE.BufferAttribute,
    indices: ArrayLike<number>,
    beginIdx: number,
    endIdx: number,
    normal: THREE.Vector3,
    displacementRange?: DisplacementRange
): THREE.Sphere {
    const sphere = new THREE.Sphere();
    const step = 6; // Two triangles per segment.
    tmpBox1.makeEmpty();
    const vertex = tmpVector1;
    for (let i = beginIdx; i < endIdx; i += step) {
        tmpBox1.expandByPoint(vertex.fromBufferAttribute(position, indices[i]));
    }

    if (displacementRange) {
        const minDispl = tmpVector2;
        const maxDispl = tmpVector3;

        minDispl.copy(normal);
        maxDispl.copy(normal);
        tmpBox2.copy(tmpBox1);
        tmpBox2
            .translate(minDispl.multiplyScalar(displacementRange.min))
            .union(tmpBox1.translate(maxDispl.multiplyScalar(displacementRange.max)));
        return tmpBox2.getBoundingSphere(sphere);
    }

    const center = tmpBox1.getCenter(sphere.center);
    let maxRadiusSq = 0;
    for (let i = beginIdx; i < endIdx; i += step) {
        vertex.fromBufferAttribute(position, indices[i]);
        maxRadiusSq = Math.max(maxRadiusSq, center.distanceToSquared(vertex));
    }
    sphere.radius = Math.sqrt(maxRadiusSq);
    return sphere;
}

/**
 * Mesh with geometry modified by a displacement map. Overrides raycasting behaviour to apply
 * displacement map before intersection test.
 * @internal
 */
export class SolidLineMesh extends THREE.Mesh {
    private static displacedPositions?: DisplacedBufferAttribute;

    private static getDisplacedPositionAttribute(
        geometry: THREE.BufferGeometry,
        displacementMap: THREE.DataTexture
    ): DisplacedBufferAttribute {
        // Reuse same buffer attribute for all meshes since it's only needed during the
        // intersection test.
        if (!SolidLineMesh.displacedPositions) {
            SolidLineMesh.displacedPositions = new DisplacedBufferAttribute(
                geometry.attributes.position,
                geometry.attributes.normal,
                geometry.attributes.uv,
                displacementMap
            );
        } else {
            SolidLineMesh.displacedPositions.reset(
                geometry.attributes.position,
                geometry.attributes.normal,
                geometry.attributes.uv,
                displacementMap
            );
        }
        return SolidLineMesh.displacedPositions;
    }

    m_displacedGeometry?: DisplacedBufferGeometry;

    /**
     * Creates an instance of displaced mesh.
     * @param m_getDisplacementRange Displacement values range getter.
     * @param [geometry] Original geometry to displace.
     * @param [material] Material(s) to be used by the mesh. All must have the same displacement
     * map.
     */
    constructor(
        private m_getDisplacementRange: () => DisplacementRange,
        geometry?: THREE.Geometry | THREE.BufferGeometry,
        material?: THREE.Material | THREE.Material[]
    ) {
        super(geometry, material);
    }

    /** @override */
    raycast(raycaster: THREE.Raycaster, intersects: THREE.Intersection[]): void {
        // All materials in the object are expected to have the same displacement map.
        const material: THREE.Material = Array.isArray(this.material)
            ? this.material[0]
            : this.material;

        // Use default raycasting implementation if some type is unexpected.
        if (
            !(this.geometry instanceof THREE.BufferGeometry) ||
            !hasDisplacementFeature(material) ||
            !(material.displacementMap instanceof THREE.DataTexture)
        ) {
            this.raycastImpl(raycaster, intersects);
            return;
        }
        const displacementMap = material.displacementMap;
        const displacementRange = this.m_getDisplacementRange();

        if (this.m_displacedGeometry) {
            this.m_displacedGeometry.reset(this.geometry, displacementMap, displacementRange);
        } else {
            this.m_displacedGeometry = new DisplacedBufferGeometry(
                this.geometry,
                displacementMap,
                displacementRange,
                SolidLineMesh.getDisplacedPositionAttribute(this.geometry, displacementMap)
            );
        }

        // Replace the original geometry by the displaced one only during the intersection test.
        this.geometry = this.m_displacedGeometry;
        this.raycastImpl(raycaster, intersects);
        this.geometry = this.m_displacedGeometry.originalGeometry;
    }

    raycastImpl(raycaster: THREE.Raycaster, intersects: THREE.Intersection[]): void {
        const solidLineMaterial = this.material as SolidLineMaterial;

        const geometry = this.geometry;
        const matrixWorld = this.matrixWorld;
        const threshold = solidLineMaterial.lineWidth + solidLineMaterial.outlineWidth;

        tmpInverseMatrix.getInverse(matrixWorld);
        tmpRay.copy(raycaster.ray).applyMatrix4(tmpInverseMatrix);

        const localThreshold = threshold / ((this.scale.x + this.scale.y + this.scale.z) / 3);
        const localThresholdSq = localThreshold * localThreshold;

        if (!(geometry instanceof THREE.BufferGeometry)) {
            assert(false);
            return;
        }

        const index = geometry.index;
        if (index === null) {
            assert(false);
            return;
        }

        geometry.userData.debug = [];
        // TODO: What to do if no feature starts.
        if (!this.userData.feature) {
            this.userData.feature = {};
        }
        const featureStarts = this.userData.feature.starts ?? [0];
        if (!this.userData.feature.boundingVolumes) {
            this.userData.feature.boundingVolumes = [];
        }
        const bVolumes = this.userData.feature.boundingVolumes;
        const attributes = geometry.attributes;
        const position = attributes.position as THREE.BufferAttribute;
        const indices = geometry.index!.array;
        let displacementRange: DisplacementRange | undefined;
        if (this.geometry === this.m_displacedGeometry) {
            tmpNormal.fromBufferAttribute(geometry.attributes.normal as THREE.BufferAttribute, 0);
            displacementRange = this.m_displacedGeometry.displacementRange;
        }

        for (let i = 0, length = featureStarts.length; i < length; ++i) {
            const beginIdx = featureStarts[i];
            const endIdx = i === length - 1 ? indices.length : featureStarts[i + 1];
            if (i >= bVolumes.length) {
                bVolumes.push(
                    computeBoundingSphere(
                        position,
                        indices,
                        beginIdx,
                        endIdx,
                        tmpNormal,
                        displacementRange
                    )
                );
            }
            this.featureIntersect(
                raycaster,
                intersects,
                threshold,
                localThresholdSq,
                beginIdx,
                endIdx,
                bVolumes[i]
            );
        }
    }

    private featureIntersect(
        raycaster: THREE.Raycaster,
        intersects: THREE.Intersection[],
        threshold: number,
        localThresholdSq: number,
        beginIdx: number,
        endIdx: number,
        bSphere: THREE.Sphere
    ): void {
        // TODO: Reuse
        const vStart = tmpVector1;
        const vEnd = tmpVector2;
        const vExtrusion = tmpVector3;
        const plane = new THREE.Plane();
        const interPlane = tmpVector4;
        const closestCenterLinePoint = new THREE.Vector3();
        const line = new THREE.Line3();
        const step = 6; // Two triangles per segment.

        const geometry = this.geometry as THREE.BufferGeometry;
        const attributes = geometry.attributes;
        const position = attributes.position as THREE.BufferAttribute;
        const bitangent = attributes.bitangent;
        const indices = geometry.index!.array;

        tmpSphere.copy(bSphere);
        tmpSphere.applyMatrix4(this.matrixWorld);
        tmpSphere.radius += threshold;

        if (!raycaster.ray.intersectsSphere(tmpSphere)) {
            return;
        }

        for (let i = beginIdx; i < endIdx; i += step) {
            const a = indices[i];
            const b = indices[i + 2]; // indices[i+1] is same vertex as indices[i], for extrusion.

            vStart.fromBufferAttribute(position, a);
            vEnd.fromBufferAttribute(position, b);
            vExtrusion.set(bitangent.getX(a), bitangent.getY(a), bitangent.getZ(a));
            // TODO: Optimize.
            plane.setFromCoplanarPoints(vStart, vStart.clone().add(vExtrusion), vEnd);
            if (!tmpRay.intersectPlane(plane, interPlane)) {
                continue;
            }
            line.set(vStart, vEnd);
            line.closestPointToPoint(interPlane, true, closestCenterLinePoint);

            const distSq = interPlane.distanceToSquared(closestCenterLinePoint);
            if (distSq > localThresholdSq) {
                continue;
            }

            //Move back to world space for distance calculation
            const interLineWorld = interPlane.clone().applyMatrix4(this.matrixWorld);

            const distance = raycaster.ray.origin.distanceTo(interLineWorld);

            if (distance < raycaster.near || distance > raycaster.far) {
                continue;
            }

            geometry.userData.debug.push({
                line: line.clone().applyMatrix4(this.matrixWorld),
                ray: new THREE.Ray(
                    interLineWorld,
                    vExtrusion.clone().transformDirection(this.matrixWorld)
                ),
                length: threshold
            });
            intersects.push({
                distance,
                point: interLineWorld,
                index: i,
                face: null,
                faceIndex: undefined,
                object: this
            });
        }
    }
}
