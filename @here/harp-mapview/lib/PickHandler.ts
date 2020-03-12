/*
 * Copyright (C) 2017-2019 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

import { GeometryType, getFeatureId, Technique } from "@here/harp-datasource-protocol";
import * as THREE from "three";

import { OrientedBox3 } from "@here/harp-geoutils";
import { LoggerManager, PerformanceTimer } from "@here/harp-utils";
import { DisplacedMesh } from "./geometry/DisplacedMesh";
import { SolidLineMesh } from "./geometry/SolidLineMesh";
import { MapView, MapViewEventNames } from "./MapView";
import { MapViewPoints } from "./MapViewPoints";
import { RoadPicker } from "./RoadPicker";
import { RoadIntersectionData, Tile, TileFeatureData } from "./Tile";

/**
 * Describes the general type of a picked object.
 */
export enum PickObjectType {
    /**
     * Unspecified.
     */
    Unspecified = 0,

    /**
     * A point object.
     */
    Point,

    /**
     * A line object.
     */
    Line,

    /**
     * An area object.
     */
    Area,

    /**
     * The text part of a [[TextElement]]
     */
    Text,

    /**
     * The Icon of a [[TextElement]].
     */
    Icon,

    /**
     * Any general 3D object, for example, a landmark.
     */
    Object3D
}

function getIntersectedFeatureIndex(intersect: THREE.Intersection): number | undefined {
    const featureData = intersect.object.userData.feature;

    if (!featureData) {
        return undefined;
    }

    if (intersect.object instanceof MapViewPoints) {
        return intersect.index!;
    }

    if (
        featureData.starts === undefined ||
        featureData.starts.length === 0 ||
        (intersect.faceIndex === undefined && intersect.index === undefined)
    ) {
        return undefined;
    }

    if (featureData.starts.length === 1) {
        return 0;
    }

    const intersectIndex =
        intersect.faceIndex !== undefined ? intersect.faceIndex * 3 : intersect.index!;

    // TODO: Implement binary search.
    let featureIndex = 0;
    for (const featureStartIndex of featureData.starts) {
        if (featureStartIndex > intersectIndex) {
            break;
        }
        featureIndex++;
    }
    return featureIndex - 1;
}

/**
 * A general pick result. You can access the details of a picked geometry from the property
 * `intersection`, which is available if a geometry was hit. If a road was hit, a [[RoadPickResult]]
 * is returned, which has additional information, but no `intersection`.
 */
export interface PickResult {
    /**
     * General type of object.
     */
    type: PickObjectType;

    /**
     * A 2D point in screen coordinates, or a 3D point in world coordinates.
     */
    point: THREE.Vector2 | THREE.Vector3;

    /**
     * Distance from the camera to the picking point; used to determine the closest object.
     */
    distance: number;

    /**
     * An optional feature ID of the picked object; typically applies to the Optimized Map
     * Vector (OMV) format.
     */
    featureId?: number;

    /**
     * Defined for geometry only.
     */
    intersection?: THREE.Intersection;

    /**
     * Defined for roads or if `enableTechniqueInfo` option is enabled.
     */
    technique?: Technique;

    /**
     * Optional user data that has been defined in the picked object. This object points directly to
     * information contained in the original [[TileFeatureData]] stored in [[MapView]], and should
     * not be modified.
     */
    userData?: any;
}

const tmpOBB = new OrientedBox3();
const logger = LoggerManager.instance.create("PickHandler");

/**
 * Handles the picking of scene geometry and roads.
 */
export class PickHandler {
    private readonly m_plane = new THREE.Plane(new THREE.Vector3(0, 0, 1));
    private readonly m_roadPicker?: RoadPicker;
    private readonly m_debugGroup = new THREE.Group();

    constructor(
        readonly mapView: MapView,
        readonly camera: THREE.Camera,
        public enableRoadPicking = true,
        public enablePickTechnique = false
    ) {
        if (enableRoadPicking) {
            this.m_roadPicker = new RoadPicker(mapView);
        }
        this.m_debugGroup.renderOrder = 10000;

        this.mapView.addEventListener(MapViewEventNames.Render, () => {
            this.m_debugGroup.position.copy(this.mapView.worldCenter).negate();
            this.m_debugGroup.updateMatrixWorld(true);
            this.mapView.scene.add(this.m_debugGroup);
        });
    }

    /**
     * The `RoadPicker` class manages picking of roads, which may not be pickable in THREE.js,
     * since their geometry is generated in the vertex shader. The `RoadPicker` requires that
     * all [[Tile]]s are registered before they can be picked successfully.
     */
    registerTile(tile: Tile): RoadIntersectionData | undefined {
        return this.m_roadPicker !== undefined ? this.m_roadPicker.registerTile(tile) : undefined;
    }

    /**
     * Does a raycast on all objects in the scene; useful for picking. This function is Limited to
     * objects that THREE.js can raycast. However, any solid lines that have their geometry in the
     * shader cannot be tested for intersection.
     *
     * @param x The X position in CSS/client coordinates, without the applied display ratio.
     * @param y The Y position in CSS/client coordinates, without the applied display ratio.
     * @returns the list of intersection results.
     */
    intersectMapObjects(x: number, y: number): PickResult[] {
        const beginTime = PerformanceTimer.now();
        this.m_debugGroup.children.length = 0;
        const worldPos = this.mapView.getNormalizedScreenCoordinates(x, y);
        const rayCaster = this.mapView.raycasterFromScreenPoint(x, y);
        const pickResults: PickResult[] = [];

        if (this.mapView.textElementsRenderer !== undefined) {
            const { clientWidth, clientHeight } = this.mapView.canvas;
            const screenX = worldPos.x * clientWidth * 0.5 * this.mapView.pixelRatio;
            const screenY = worldPos.y * clientHeight * 0.5 * this.mapView.pixelRatio;
            const scenePosition = new THREE.Vector2(screenX, screenY);
            this.mapView.textElementsRenderer.pickTextElements(scenePosition, pickResults);
        }
        const textTime = PerformanceTimer.now();

        const intersects: THREE.Intersection[] = [];
        const tileList = this.mapView.visibleTileSet.dataSourceTileList;
        tileList.forEach(dataSourceTileList => {
            if (
                dataSourceTileList.dataSource.name === "Terrain" ||
                dataSourceTileList.dataSource.name === "background"
            ) {
                return;
            }
            dataSourceTileList.renderedTiles.forEach(tile => {
                tmpOBB.copy(tile.boundingBox);
                tmpOBB.position.sub(this.mapView.worldCenter);

                if (tmpOBB.intersectsRay(rayCaster.ray) !== undefined) {
                    this.addDebugWorldOBBox(tile.boundingBox, new THREE.Color("red"));
                    rayCaster.intersectObjects(tile.objects, true, intersects);
                }
            });
        });
        const geometryTime = PerformanceTimer.now();

        for (const intersect of intersects) {
            const pickResult: PickResult = {
                type: PickObjectType.Unspecified,
                point: intersect.point,
                distance: intersect.distance,
                intersection: intersect
            };

            if (
                intersect.object.userData === undefined ||
                intersect.object.userData.feature === undefined
            ) {
                pickResults.push(pickResult);
                continue;
            }

            this.addDebugIntersect(intersect);

            const featureData: TileFeatureData = intersect.object.userData.feature;
            if (this.enablePickTechnique) {
                pickResult.technique = intersect.object.userData.technique;
            }

            this.addObjInfo(featureData, intersect, pickResult);

            if (featureData.objInfos !== undefined) {
                const featureId =
                    featureData.objInfos.length === 1
                        ? getFeatureId(featureData.objInfos[0])
                        : undefined;
                pickResult.featureId = featureId;
            }

            let pickObjectType: PickObjectType;

            switch (featureData.geometryType) {
                case GeometryType.Point:
                case GeometryType.Text:
                    pickObjectType = PickObjectType.Point;
                    break;
                case GeometryType.Line:
                case GeometryType.ExtrudedLine:
                case GeometryType.SolidLine:
                case GeometryType.TextPath:
                    pickObjectType = PickObjectType.Line;
                    break;
                case GeometryType.Polygon:
                case GeometryType.ExtrudedPolygon:
                    pickObjectType = PickObjectType.Area;
                    break;
                case GeometryType.Object3D:
                    pickObjectType = PickObjectType.Object3D;
                    break;
                default:
                    pickObjectType = PickObjectType.Unspecified;
            }

            pickResult.type = pickObjectType;
            pickResults.push(pickResult);
        }

        const endTime = PerformanceTimer.now();
        logger.log(
            `Picking time (text: ${textTime - beginTime}ms, geometry: ${geometryTime -
                textTime}ms, total: ${endTime - beginTime}ms`
        );
        if (this.enableRoadPicking) {
            const planeIntersectPosition = new THREE.Vector3();
            const cameraPos = this.mapView.camera.position.clone();

            rayCaster.setFromCamera(worldPos, this.mapView.camera);
            rayCaster.ray.intersectPlane(this.m_plane, planeIntersectPosition);

            this.mapView.forEachVisibleTile(tile => {
                this.m_roadPicker!.intersectRoads(
                    tile,
                    cameraPos,
                    planeIntersectPosition,
                    pickResults
                );
            });
        }

        pickResults.sort((a: PickResult, b: PickResult) => {
            return a.distance - b.distance;
        });
        if (pickResults.length > 0) {
            this.addDebugRay(rayCaster.ray, pickResults[0].distance, new THREE.Color("yellow"));
        }

        this.mapView.update();
        return pickResults;
    }

    private addDebugRay(
        ray: THREE.Ray,
        length: number,
        color: THREE.Color,
        headLengthFactor: number = 0.1,
        headWidthFactor: number = 0.01
    ) {
        ray = ray.clone();
        ray.origin.add(this.mapView.worldCenter);

        const rayHelper = new THREE.ArrowHelper(
            ray.direction,
            ray.origin,
            length,
            color.getHex(),
            length * headLengthFactor,
            length * headWidthFactor
        );
        (rayHelper.line.material as THREE.Material).depthTest = false;
        (rayHelper.cone.material as THREE.Material).depthTest = false;
        this.m_debugGroup.add(rayHelper);
    }

    private addDebugLine(line: THREE.Line3) {
        const geometry = new THREE.BufferGeometry().setFromPoints([line.start, line.end]);
        const material = new THREE.LineBasicMaterial({
            color: "black",
            depthTest: false
        });
        const lineObject = new THREE.Line(geometry, material);
        lineObject.position.copy(this.mapView.worldCenter);
        lineObject.updateMatrixWorld(true);
        this.m_debugGroup.add(lineObject);
    }

    private addDebugIntersect(intersect: THREE.Intersection) {
        if (intersect.object instanceof DisplacedMesh && intersect.object.m_displacedGeometry) {
            const geometry = (intersect.object.m_displacedGeometry ??
                intersect.object.geometry) as THREE.BufferGeometry;
            this.addDebugBBox(
                intersect.object.position,
                geometry.boundingBox,
                new THREE.Color("blue")
            );
        } else if (intersect.object instanceof SolidLineMesh) {
            const geometry = (intersect.object.m_displacedGeometry ??
                intersect.object.geometry) as THREE.BufferGeometry;
            const featureIndex = getIntersectedFeatureIndex(intersect) ?? 0;
            const boundingVolumes = intersect.object.userData.feature.boundingVolumes;
            if (
                featureIndex !== undefined &&
                boundingVolumes &&
                boundingVolumes.length > featureIndex
            ) {
                this.addDebugBSphere(
                    intersect.object.position,
                    boundingVolumes[featureIndex],
                    new THREE.Color("magenta")
                );
            }
            if (
                geometry.userData &&
                geometry.userData.debug &&
                geometry.userData.debug.length > 0
            ) {
                const { line, ray, length } = geometry.userData.debug[0];
                this.addDebugRay(ray, length, new THREE.Color("red"), 0.3, 0.2);
                this.addDebugLine(line);
            }
        } else if (intersect.object instanceof THREE.Mesh) {
            const geometry = intersect.object.geometry;
            if (!geometry.boundingBox) {
                geometry.computeBoundingBox();
            }
            this.addDebugBBox(
                intersect.object.position,
                geometry.boundingBox,
                new THREE.Color("blue")
            );
        }
    }

    private addDebugBSphere(position: THREE.Vector3, sphere: THREE.Sphere, color: THREE.Color) {
        const material = new THREE.MeshBasicMaterial({
            color,
            wireframe: true,
            wireframeLinewidth: 2.0
        });
        const sphereGeometry = new THREE.SphereGeometry(sphere.radius);
        sphereGeometry.translate(sphere.center.x, sphere.center.y, sphere.center.z);
        const mesh = new THREE.Mesh(sphereGeometry, material);
        mesh.position.copy(position).add(this.mapView.worldCenter);
        this.m_debugGroup.add(mesh);
    }

    private addDebugBBox(position: THREE.Vector3, box: THREE.Box3, color: THREE.Color) {
        box = box.clone();
        box.translate(position).translate(this.mapView.worldCenter);
        this.addDebugWorldBBox(box, color);
    }

    private addDebugWorldOBBox(obb: OrientedBox3, color: THREE.Color) {
        const box = new THREE.Box3(obb.extents.clone().negate(), obb.extents.clone());
        box.translate(obb.position);
        this.addDebugWorldBBox(box, color, obb.getRotationMatrix());
    }

    private addDebugWorldBBox(bbox: THREE.Box3, color: THREE.Color, matrix?: THREE.Matrix4) {
        if (bbox.getSize(new THREE.Vector3()).z === 0) {
            bbox.max.z = bbox.min.z + 1;
        }
        const helper = new THREE.Box3Helper(bbox, color);
        if (matrix) {
            helper.setRotationFromMatrix(matrix);
        }
        this.m_debugGroup.add(helper);
    }

    private addObjInfo(
        featureData: TileFeatureData,
        intersect: THREE.Intersection,
        pickResult: PickResult
    ) {
        if (featureData.objInfos === undefined) {
            return;
        }

        const featureIndex = getIntersectedFeatureIndex(intersect);
        if (featureIndex !== undefined) {
            pickResult.userData = featureData.objInfos[featureIndex];
        }
    }
}
