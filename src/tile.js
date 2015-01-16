/*global Tile */
import {Geo} from './geo';
import {StyleParser} from './styles/style_parser';
import WorkerBroker from './worker_broker';

import log from 'loglevel';

export default class Tile {

    /**
        Tile
        @constructor
        Required properties:
        spec.coords: object with {x, y, z} properties identifying tile coordinate location
        spec.tile_source: TileSource from which tile will be loaded
    */
    constructor(spec) {
        Object.assign(this, {
            coords: {
                x: null,
                y: null,
                z: null
            },
            debug: {},
            loading: false,
            loaded: false,
            error: null,
            worker: null,
            order: {
                min: Infinity,
                max: -Infinity
            }
        }, spec);

        this.coords = this.tile_source.calculateOverZoom(this.coords);
        this.key = [this.coords.x, this.coords.y, this.coords.z].join('/');
    }

    static create(spec) { return new Tile(spec); }

    freeResources() {
        if (this != null && this.gl_geometry != null) {
            for (var p in this.gl_geometry) {
                this.gl_geometry[p].destroy();
            }
            this.gl_geometry = null;
        }
    }

    destroy() {
        this.freeResources();
        this.worker = null;
    }

    buildAsMessage() {
        return {
            key: this.key,
            coords: this.coords,
            min: this.min,
            max: this.max,
            order: this.order,
            debug: this.debug
        };
    }

    workerMessage (...message) {
        return WorkerBroker.postMessage(this.worker, ...message);
    }

    // TODO: remove scene dependency
    build(scene) {
        scene.trackTileBuildStart(this.key);
        this.workerMessage(
            'buildTile',
            { tile: this.buildAsMessage() })
        .then(message => {
            scene.buildTileCompleted(message);
        });
    }

    // Process geometry for tile - called by web worker
    // Returns a set of tile keys that should be sent to the main thread (so that we can minimize data exchange between worker and main thread)
    static buildGeometry (tile, layers, rules, styles) {
        var name, layer, feature, style, feature_style;
        var vertex_data = {};
        var style_vertex_data;

        tile.debug.rendering = +new Date();
        tile.debug.features = 0;

        // Treat top-level style rules as 'layers'
        for (name in layers) {
            layer = layers[name];

            // Skip layers with no geometry defined
            // TODO: this should be a warning
            if (!layer.geometry) {
                continue;
            }

            var geom = Tile.getGeometryForSource(tile, layer.geometry);
            if (geom) {
                var num_features = geom.features.length;

                // Render features within each layer, in reverse order - aka top to bottom
                for (var f = num_features-1; f >= 0; f--) {
                    feature = geom.features[f];
                    feature.layer = name;

                    var context = StyleParser.getFeatureParseContext(feature, tile);

                    // Find matching rules
                    var matchedRules = [];
                    var layer_rules = rules[name];
                    for (var r in layer_rules) {
                        layer_rules[r].matchFeature(context, matchedRules);
                    }

                    // Parse & render styles
                    for (var rule of matchedRules) {
                        if (!rule.visible) {
                            continue;
                        }

                        // Add style 'properties' to context
                        context.style_properties = rule.properties;

                        // Parse style
                        var style_name = rule.name;
                        if (typeof style_name === 'function') {
                            style_name = style_name(context);
                        }
                        style_name = style_name || StyleParser.defaults.style.name;

                        style = styles[style_name];
                        feature_style = style.parseFeature(feature, rule, tile, context);

                        // Skip feature?
                        if (!feature_style) {
                            continue;
                        }

                        // Track min/max order range
                        if (feature_style.order < tile.order.min) {
                            tile.order.min = feature_style.order;
                        }
                        if (feature_style.order > tile.order.max) {
                            tile.order.max = feature_style.order;
                        }

                        // First feature in this render style?
                        if (vertex_data[style.name] == null) {
                            vertex_data[style.name] = style.vertex_layout.createVertexData();
                        }
                        style_vertex_data = vertex_data[style.name];

                        // Layer order: 'order' property between [-1, 1] adjusts render order of features *within* this layer
                        // Does not affect order outside of this layer, e.g. all features on previous layers are drawn underneath
                        //  this one, all features on subsequent layers are drawn on top of this one
                        // feature_style.layer = (layer.geometry.order || 0) + 0.5;      // 'center' this layer at 0.5 above the baseline
                        // feature_style.layer += feature_style.order / 2.5;   // scale [-1, 1] to [-.4, .4] to stay within layer bounds, .1 buffer to be safe
                        feature_style.layer = feature_style.order;

                        if (feature.geometry.type === 'Polygon') {
                            style.buildPolygons([feature.geometry.coordinates], feature_style, style_vertex_data);
                        }
                        else if (feature.geometry.type === 'MultiPolygon') {
                            style.buildPolygons(feature.geometry.coordinates, feature_style, style_vertex_data);
                        }
                        else if (feature.geometry.type === 'LineString') {
                            style.buildLines([feature.geometry.coordinates], feature_style, style_vertex_data);
                        }
                        else if (feature.geometry.type === 'MultiLineString') {
                            style.buildLines(feature.geometry.coordinates, feature_style, style_vertex_data);
                        }
                        else if (feature.geometry.type === 'Point') {
                            style.buildPoints([feature.geometry.coordinates], feature_style, style_vertex_data);
                        }
                        else if (feature.geometry.type === 'MultiPoint') {
                            style.buildPoints(feature.geometry.coordinates, feature_style, style_vertex_data);
                        }
                    }

                    tile.debug.features++;
                }
            }
        }

        // Finalize array buffer for each render style
        tile.vertex_data = {};
        for (var m in vertex_data) {
            tile.vertex_data[m] = vertex_data[m].end().buffer;
        }

        tile.debug.rendering = +new Date() - tile.debug.rendering;

        // Return keys to be transfered to main thread
        return {
            vertex_data: true
        };
    }

    /**
        Retrieves geometry from a tile according to a data source definition
    */
    static getGeometryForSource (tile, source) {
        var geom;

        if (source != null) {
            // Just pass through data untouched if no data transform function defined
            // if (!source.filter) {
            //     geom = tile.layers[source.filter];
            // }
            // Pass through data but with different layer name in tile source data
            /*else*/ if (typeof source.filter === 'string') {
                geom = tile.layers[source.filter];
            }
            // Apply the transform function for post-processing
            else if (typeof source.filter === 'function') {
                geom = source.filter(tile.layers);
            }
        }

        // Handle cases where no data was found in tile or returned by post-processor
        geom = geom || { type: 'FeatureCollection', features: [] };

        return geom;
    }

    /**
       Called on main thread when a web worker completes processing
       for a single tile.
    */
    finalizeGeometry(styles) {
        var vertex_data = this.vertex_data;
        // Cleanup existing GL geometry objects
        this.freeResources();
        this.gl_geometry = {};

        // Create GL geometry objects
        for (var s in vertex_data) {
            this.gl_geometry[s] = styles[s].makeGLGeometry(vertex_data[s]);
        }

        this.debug.geometries = 0;
        this.debug.buffer_size = 0;
        for (var p in this.gl_geometry) {
            this.debug.geometries += this.gl_geometry[p].geometry_count;
            this.debug.buffer_size += this.gl_geometry[p].vertex_data.byteLength;
        }
        this.debug.geom_ratio = (this.debug.geometries / this.debug.features).toFixed(1);

        delete this.vertex_data; // TODO: might want to preserve this for rebuilding geometries when styles/etc. change?
    }

    remove() {
        this.workerMessage('removeTile', this.key);
    }

    showDebug(div) {
        var debug_overlay = document.createElement('div');
        debug_overlay.textContent = this.key;
        debug_overlay.style.position = 'absolute';
        debug_overlay.style.left = 0;
        debug_overlay.style.top = 0;
        debug_overlay.style.color = 'white';
        debug_overlay.style.fontSize = '16px';
        debug_overlay.style.textOutline = '1px #000000';
        div.appendChild(debug_overlay);
        div.style.borderStyle = 'solid';
        div.style.borderColor = 'white';
        div.style.borderWidth = '1px';
        return debug_overlay;
    }

    printDebug () {
        log.debug(`Tile: debug for ${this.key}: [  ${JSON.stringify(this.debug)} ]`);
    }

    updateDebugElement(div, show) {
        div.setAttribute('data-tile-key', this.key);
        div.style.width = '256px';
        div.style.height = '256px';

        if (show) {
            this.showDebug(div);
        }
    }

    // TODO: pass bounds only, rest of scene isn't needed
    updateVisibility(scene) {
        var visible = this.visible;
        this.visible = this.isInZoom(scene) && Geo.boxIntersect(this.bounds, scene.bounds_meters_buffered);
        this.center_dist = Math.abs(scene.center_meters.x - this.min.x) + Math.abs(scene.center_meters.y - this.min.y);
        return (visible !== this.visible);
    }

    // TODO: pass zoom only?
    isInZoom(scene) {
        return (Math.min(this.coords.z, this.tile_source.max_zoom || this.coords.z)) === scene.capped_zoom;
    }

    load(scene) {
        scene.trackTileSetLoadStart();

        this.min = Geo.metersForTile(this.coords);
        this.max = Geo.metersForTile({x: this.coords.x + 1, y: this.coords.y + 1, z: this.coords.z }),
        this.span = { x: (this.max.x - this.min.x), y: (this.max.y - this.min.y) };
        this.bounds = { sw: { x: this.min.x, y: this.max.y }, ne: { x: this.max.x, y: this.min.y } };
        this.loading = true;

        this.build(scene);
        this.updateVisibility(scene);
    }

    merge(other) {
        for (var key in other) {
            if (key !== 'key') {
                this[key] = other[key];
            }
        }
        return this;
    }

}
