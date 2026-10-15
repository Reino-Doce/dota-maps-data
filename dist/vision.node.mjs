import require$$0 from 'jimp';

function getDefaultExportFromCjs (x) {
	return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, 'default') ? x['default'] : x;
}

var imageHandler;
var hasRequiredImageHandler;

function requireImageHandler () {
	if (hasRequiredImageHandler) return imageHandler;
	hasRequiredImageHandler = 1;
	var Jimp = require$$0;

	function ImageHandler(imagePath) {
	    this.imagePath = imagePath;
	    this.image = null;
	    this.enabled = true;
	}
	ImageHandler.prototype.load = function (callback) {
	    var self = this;
	    Jimp.read(this.imagePath).then(function (image) {
	        self.image = image;
	        if (self.enabled) callback();
	    }).catch(function (err) {
	        console.log('error', err);
	        if (self.enabled) callback(err);
	    });
	};
	ImageHandler.prototype.disable = function () {
	    this.enabled = false;
	};
	ImageHandler.prototype.scan = function (offset, width, height, pixelHandler, grid) {
	    this.image.scan(offset, 0, width, height, function (x, y, idx) {
	        var r = this.bitmap.data[idx + 0];
	        var g = this.bitmap.data[idx + 1];
	        var b = this.bitmap.data[idx + 2];
	        this.bitmap.data[idx + 3];
	        pixelHandler(x - offset, y, [r, g, b], grid);
	    });
	};

	imageHandler = ImageHandler;
	return imageHandler;
}

/*
	This is rot.js, the ROguelike Toolkit in JavaScript.
	Version 0.6~dev, generated on Tue Mar 17 16:16:31 CET 2015.
*/

var rot6;
var hasRequiredRot6;

function requireRot6 () {
	if (hasRequiredRot6) return rot6;
	hasRequiredRot6 = 1;
	/**
	 * @namespace Top-level ROT namespace
	 */
	var ROT = {
		/** Directional constants. Ordering is important! */
		DIRS: {
			"4": [
				[ 0, -1],
				[ 1,  0],
				[ 0,  1],
				[-1,  0]
			],
			"8": [
				[ 0, -1],
				[ 1, -1],
				[ 1,  0],
				[ 1,  1],
				[ 0,  1],
				[-1,  1],
				[-1,  0],
				[-1, -1]
			],
			"6": [
				[-1, -1],
				[ 1, -1],
				[ 2,  0],
				[ 1,  1],
				[-1,  1],
				[-2,  0]
			]
		}
	};
	/**
	 * Always positive modulus
	 * @param {int} n Modulus
	 * @returns {int} this modulo n
	 */
	Number.prototype.mod = function(n) {
		return ((this%n)+n)%n;
	};
	if (!Object.create) {
		/**
		 * ES5 Object.create
		 */
		Object.create = function(o) {
			var tmp = function() {};
			tmp.prototype = o;
			return new tmp();
		};
	}
	/**
	 * Sets prototype of this function to an instance of parent function
	 * @param {function} parent
	 */
	Function.prototype.extend = function(parent) {
		this.prototype = Object.create(parent.prototype);
		this.prototype.constructor = this;
		return this;
	};
	if (typeof window != "undefined") {
		window.requestAnimationFrame =
			window.requestAnimationFrame
			|| window.mozRequestAnimationFrame
			|| window.webkitRequestAnimationFrame
			|| window.oRequestAnimationFrame
			|| window.msRequestAnimationFrame
			|| function(cb) { return setTimeout(cb, 1000/60); };

		window.cancelAnimationFrame =
			window.cancelAnimationFrame
			|| window.mozCancelAnimationFrame
			|| window.webkitCancelAnimationFrame
			|| window.oCancelAnimationFrame
			|| window.msCancelAnimationFrame
			|| function(id) { return clearTimeout(id); };
	}
	/**
	 * @class Abstract FOV algorithm
	 * @param {function} lightPassesCallback Does the light pass through x,y?
	 * @param {object} [options]
	 * @param {int} [options.topology=8] 4/6/8
	 */
	ROT.FOV = function(lightPassesCallback, options) {
		this._lightPasses = lightPassesCallback;
		this._options = {
			topology: 8
		};
		for (var p in options) { this._options[p] = options[p]; }
	};

	/**
	 * Compute visibility for a 360-degree circle
	 * @param {int} x
	 * @param {int} y
	 * @param {int} R Maximum visibility radius
	 * @param {function} callback
	 */
	ROT.FOV.prototype.compute = function(x, y, R, callback) {};

	/**
	 * Return all neighbors in a concentric ring
	 * @param {int} cx center-x
	 * @param {int} cy center-y
	 * @param {int} r range
	 */
	ROT.FOV.prototype._getCircle = function(cx, cy, r) {
		var result = [];
		var dirs, countFactor, startOffset;

		switch (this._options.topology) {
			case 4:
				countFactor = 1;
				startOffset = [0, 1];
				dirs = [
					ROT.DIRS[8][7],
					ROT.DIRS[8][1],
					ROT.DIRS[8][3],
					ROT.DIRS[8][5]
				];
			break;

			case 6:
				dirs = ROT.DIRS[6];
				countFactor = 1;
				startOffset = [-1, 1];
			break;

			case 8:
				dirs = ROT.DIRS[4];
				countFactor = 2;
				startOffset = [-1, 1];
			break;
		}

		/* starting neighbor */
		var x = cx + startOffset[0]*r;
		var y = cy + startOffset[1]*r;

		/* circle */
		for (var i=0;i<dirs.length;i++) {
			for (var j=0;j<r*countFactor;j++) {
				result.push([x, y]);
				x += dirs[i][0];
				y += dirs[i][1];

			}
		}

		return result;
	};
	/**
	 * @class Precise shadowcasting algorithm
	 * @augments ROT.FOV
	 */
	ROT.FOV.PreciseShadowcasting = function(lightPassesCallback, options) {
		ROT.FOV.call(this, lightPassesCallback, options);
	};
	ROT.FOV.PreciseShadowcasting.extend(ROT.FOV);

	ROT.FOV.PreciseShadowcasting.prototype.compute = function(x, y, R, callback) {
		/* this place is always visible */
		callback(x, y, 0, 1);

		callback(x-1, y-1, 0, 1);
		callback(x, y-1, 0, 1);
		callback(x+1, y-1, 0, 1);
		callback(x-1, y, 0, 1);
		callback(x+1, y, 0, 1);
		callback(x-1, y+1, 0, 1);
		callback(x, y+1, 0, 1);
		callback(x+1, y+1, 0, 1);

	    callback(x-1, y-2, 0, 1);
	    callback(x, y-2, 0, 1);
	    callback(x+1, y-2, 0, 1);
	    callback(x-2, y-1, 0, 1);
	    callback(x-2, y, 0, 1);
	    callback(x-2, y+1, 0, 1);
	    callback(x+2, y-1, 0, 1);
	    callback(x+2, y, 0, 1);
	    callback(x+2, y+1, 0, 1);
	    callback(x-1, y+2, 0, 1);
	    callback(x, y+2, 0, 1);
	    callback(x+1, y+2, 0, 1);

		/* standing in a dark place. FIXME is this a good idea?  */
		if (!this._lightPasses(x, y)) { return; }

		/* list of all shadows */
		var SHADOWS = [];
		var trees = {};
		var totalNeighborCount = 1;
	    var cx, cy, blocks, A1, A2, visibility,
	        dx, dy, dd, a, b, radius,
	        cx2, cy2, dx1, dy1, dd1,
	        obstacleType;

		/* analyze surrounding cells in concentric rings, starting from the center */
		for (var r=1; r<=R; r++) {
			var neighbors = this._getCircle(x, y, r);
			var neighborCount = neighbors.length;
	        totalNeighborCount += neighborCount;
	        trees = {};
			for (var i=0;i<neighborCount;i++) {
				cx = neighbors[i][0];
				cy = neighbors[i][1];
	            var key = cx+","+cy;
	            if ((x-cx)*(x-cx) + (y-cy)*(y-cy) >= R * R) {
	                totalNeighborCount--;
	                continue;
	            }
	            //if (key == "44,102") //console.log('KEY', key, !this._lightPasses(cx, cy));
	            // if (key == "150,160") //console.log(key, obstacleType);
	            // if (key == "151,161") //console.log(key, obstacleType);
	            // if (key == "150,161") //console.log(key, obstacleType);
	            var obstacleTypes = obstacleTypes = this.walls[key];
	            if (obstacleTypes && obstacleTypes.length) {
	                var skipVisibility = false;
	                for (var j = 0; j < obstacleTypes.length; j++) {
	                    var obstacleType = obstacleTypes[j];
	                    cx2 = obstacleType[1];
	                    cy2 = obstacleType[2];
	                    radius = obstacleType[3];

	                    dx = cx2 - x;
	                    dy = cy2 - y;
	                    dd = Math.sqrt(dx * dx + dy * dy);
	                    if (dd > 1/2) {
	                        a = Math.asin(radius / dd);
	                        b = Math.atan2(dy, dx),
	                        A1 = normalize(b - a),
	                        A2 = normalize(b + a);
	                        blocks = !this._lightPasses(cx, cy);

	                        dx1 = cx - x;
	                        dy1 = cy - y;
	                        dd1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
	                        if (dd1 < dd) {
	                            trees[obstacleType[1]+","+obstacleType[2]] = [obstacleType[1], obstacleType[2]];
	                        }

	                        dx = cx - x;
	                        dy = cy - y;
	                        dd = Math.sqrt(dx * dx + dy * dy);
	                        a = Math.asin(radius / dd);
	                        b = Math.atan2(dy, dx),
	                        A1 = normalize(b - a),
	                        A2 = normalize(b + a);
	                        visibility = this._checkVisibility(b, A1, A2, false, SHADOWS);
	                        if (!visibility) skipVisibility = true;
	                    }
	                }
	                if (visibility && !skipVisibility) { callback(cx, cy, r, visibility); }
	            }
	            else {
	                cx2 = cx;
	                cy2 = cy;
	                radius = Math.SQRT2 / 2;

	                dx = cx2 - x;
	                dy = cy2 - y;
	                dd = Math.sqrt(dx * dx + dy * dy);
	                if (dd > 1/2) {
	                    a = Math.asin(radius / dd);
	                    b = Math.atan2(dy, dx),
	                    A1 = normalize(b - a),
	                    A2 = normalize(b + a);
	                    blocks = !this._lightPasses(cx, cy);

	                    visibility = this._checkVisibility(b, A1, A2, blocks, SHADOWS);
	                    if (visibility) { callback(cx, cy, r, visibility); }
	                    if (this.done) return;
	                }
	            }

	            /*dx = cx2 - x;
	            dy = cy2 - y;
	            dd = Math.sqrt(dx * dx + dy * dy);
	            if (dd > 1/2) {
	                a = Math.asin(radius / dd);
	                b = Math.atan2(dy, dx),
	                A1 = normalize(b - a),
	                A2 = normalize(b + a);
	                blocks = !this._lightPasses(cx, cy);
	                if (obstacleType && obstacleType[0] == 'tree') {
	                    dx1 = cx - x;
	                    dy1 = cy - y;
	                    dd1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
	                    if (dd1 < dd) {
	                        trees[obstacleType[1]+","+obstacleType[2]] = [obstacleType[1], obstacleType[2]];
	                    }

	                    dx = cx - x;
	                    dy = cy - y;
	                    dd = Math.sqrt(dx * dx + dy * dy);
	                    a = Math.asin(radius / dd);
	                    b = Math.atan2(dy, dx),
	                    A1 = normalize(b - a),
	                    A2 = normalize(b + a);
	                    visibility = this._checkVisibility(b, A1, A2, false, SHADOWS);
	                    if (visibility) { callback(cx, cy, r, visibility); }
	                }
	                else {
	                    //if (obstacleType) //console.log(obstacleType[0], radius);
	                    //console.log('BLOCKS', cx, cy, blocks, b);
	                    visibility = this._checkVisibility(b, A1, A2, blocks, SHADOWS);
	                    if (visibility) { callback(cx, cy, r, visibility); }
	                    if (this.done) return;
	                }
	            }*/

			} /* for all cells in this ring */

	        // apply tree blockers
	        for (var k in trees) {
	            ////console.log('apply tree');
	            cx2 = trees[k][0];
	            cy2 = trees[k][1];
	            dx = cx2 - x;
	            dy = cy2 - y;
	            dd = Math.sqrt(dx * dx + dy * dy);
	            radius = Math.SQRT2 - .01;
	            if (dd > 1/2) {
	                a = Math.asin(radius / dd);
	                b = Math.atan2(dy, dx),
	                A1 = normalize(b - a),
	                A2 = normalize(b + a);
	                visibility = this._checkVisibility(b, A1, A2, true, SHADOWS);
	                if (this.done) return;
	            }
	        }
		} /* for all rings */

	    return totalNeighborCount;
	};

	/**
	 * @param {int[2]} A1 arc start
	 * @param {int[2]} A2 arc end
	 * @param {bool} blocks Does current arc block visibility?
	 * @param {int[][]} SHADOWS list of active shadows
	 */
	ROT.FOV.PreciseShadowcasting.prototype._checkVisibility = function(b, A1, A2, blocks, SHADOWS) {
	    ////console.log('_checkVisibility', b, A1, A2, blocks, SHADOWS);
	    // check if target center is inside a shadow
	    var visible = !blocks;
	    //console.log('_checkVisibility', b, visible);
		for (var i = 0; i < SHADOWS.length; i++) {
			var old = SHADOWS[i];
	        if (isBetween(b, old[0], old[1])) {
	            if (blocks) {
	                ////console.log('blocks but not visible', SHADOWS.length);
	                visible = false;
	            }
	            else {
	                //console.log(i, b, JSON.stringify(SHADOWS));
	                return false; // not visible, return
	            }
	        }
		}

	    if (blocks) {
	        if (A1 < 0 && A2 >= 0) {
	            //console.log('splitting');
	            this._mergeShadows(b, 0, A2, blocks, SHADOWS);
	            this.done = false;
	            this._mergeShadows(b, A1, 0, blocks, SHADOWS);
	        }
	        else {
	            //console.log('not splitting', blocks, visible, b);
	            this._mergeShadows(b, A1, A2, blocks, SHADOWS);
	        }
	        //console.log('end', A1, A2, JSON.stringify(SHADOWS), !isBetween(A1, SHADOWS[0][0], SHADOWS[0][1]), !isBetween(A2, SHADOWS[0][0], SHADOWS[0][1]));
	        if (SHADOWS.length == 1 && (!isBetween(A1, SHADOWS[0][0], SHADOWS[0][1]) || !isBetween(A2, SHADOWS[0][0], SHADOWS[0][1])) && A1 != SHADOWS[0][0] && A2 != SHADOWS[0][1] ) {
	            this.done = true;
	        }
	    }

	    return visible;
	};

	ROT.FOV.PreciseShadowcasting.prototype._mergeShadows = function(b, A1, A2, blocks, SHADOWS) {
	    ////console.log('merging', b, A1, A2);
	    // check if target first edge is inside a shadow or which shadows it is between
	    var index1 = 0,
	        edge1 = false,
	        firstIndex = 0;
	    while (index1 < SHADOWS.length) {
	        var old = SHADOWS[index1];
	        firstIndex = index1;
	        if (isBetween(A1, old[0], old[1])) {
	            edge1 = true;
	            break;
	        }
	        if (index1 > 0 && isBetween(A1, SHADOWS[index1 - 1][1], old[0])) {
	            edge1 = false;
	            break;
	        }
	        if (!isBefore(A1, old[1])) {
	            index1++;
	            firstIndex = index1;
	            continue;
	        }
	        if (isBefore(A1, old[0])) {
	            break;
	        }
	        index1++;
	    }

	    // check if target second edge is inside a shadow or which shadows it is between
	    var index2 = SHADOWS.length - 1,
	        edge2 = false,
	        secondIndex = 0;
	    while (index2 >= 0) {
	        var old = SHADOWS[index2];
	        secondIndex = index2;
	        ////console.log(A2, old[0], old[1], isBetween(A2, old[0], old[1]))
	        if (isBetween(A2, old[0], old[1])) {
	            edge2 = true;
	            break;
	        }
	        if (isBefore(A2, old[0])) {
	            index2--;
	            secondIndex = index2;
	            continue;
	        }
	        if (!isBefore(A2, old[1])) {
	            break;
	        }
	        index2--;
	    }

	    ////console.log(firstIndex, secondIndex, edge1, edge2, A1, A2);
	    if (firstIndex == SHADOWS.length && !edge1 && secondIndex == 0 && edge2) firstIndex = 0;
	    //if (secondIndex == -1) secondIndex = SHADOWS.length - 1;
	    //console.log(firstIndex, secondIndex, edge1, edge2, A1, A2);
	    //console.log(JSON.stringify(SHADOWS));
	    if (SHADOWS.length == 0) {
	        //console.log('empty shadows pushing', [A1, A2]);
	        SHADOWS.push([A1, A2]);
	    }
	    /*else if (SHADOWS.length > 1 && firstIndex == SHADOWS.length && secondIndex == 0 && !edge1 && edge2) {

	    }*/
	    else {
	        var new_shadow = [edge1 ? SHADOWS[firstIndex][0] : A1, edge2 ? SHADOWS[secondIndex][1] : A2];
	        //console.log('new_shadow', new_shadow);
	        secondIndex = Math.max(firstIndex, secondIndex);
	        var sum1 = diff_sum(SHADOWS);
	        var doShift = false;
	        if (isBetween(0, new_shadow[0], new_shadow[1]) && new_shadow[0] != 0 && new_shadow[1] != 0) {
	            //console.log('crosses 0');
	            SHADOWS.splice(firstIndex, firstIndex == secondIndex && edge1 == edge2 && !edge1 ? 0 : secondIndex - firstIndex + 1, [new_shadow[0], 0]);
	            //console.log([new_shadow[0], 0], JSON.stringify(SHADOWS));
	            if (SHADOWS[0][0] != 0 && SHADOWS[0][1] != new_shadow[1]) {
	                SHADOWS.splice(firstIndex + 1, 0, [0, new_shadow[1]]);
	                //console.log([0, new_shadow[1]], JSON.stringify(SHADOWS));
	            }
	            //console.log(JSON.stringify(SHADOWS));
	            doShift = true;
	        }
	        else {
	            SHADOWS.splice(firstIndex, firstIndex == secondIndex && edge1 == edge2 && !edge1 ? 0 : secondIndex - firstIndex + 1, new_shadow);
	        }
	        var sum2 = diff_sum(SHADOWS);
	        //console.log('sum1', sum1, 'sum2', sum2, sum2 < sum1, SHADOWS.length == 1 && (!isBetween(A1, SHADOWS[0][0], SHADOWS[0][1]) || !isBetween(A2, SHADOWS[0][0], SHADOWS[0][1])));
	        if (sum2 < sum1) this.done = true;
	        /*if (SHADOWS.length == 1 && (!isBetween(A1, SHADOWS[0][0], SHADOWS[0][1]) || !isBetween(A2, SHADOWS[0][0], SHADOWS[0][1]))) {
	            this.done = true;
	        }*/
	        if (new_shadow[0] == 0 || doShift) {
	            var count = 0;
	            //console.log('shifting');
	            while (SHADOWS[0][0] != 0) {
	                SHADOWS.push(SHADOWS.shift());
	                if (count >= SHADOWS.length) break;
	                count++;
	                //console.log(JSON.stringify(SHADOWS));
	            }
	            //console.log('end shifting', JSON.stringify(SHADOWS));
	        }
	        //console.log(JSON.stringify(SHADOWS));
	        //console.log(diff_sum(SHADOWS));
	    }
	};

	function isBefore(A1, A2) {
	    if (A1 > 0 && A2 < 0) { // A1 in bottom half, A2 in top half
	        return true;
	    }
	    else if (A2 > 0 && A1 < 0) { // A1 in top half, A2 in bottom half
	        return false;
	    }
	    else {
	        return A1 < A2;
	    }
	}

	function isAfter(A1, A2) {
	    return !isBefore(A1, A2);
	}

	function isBetween(b, A1, A2) {
	    if (A1 < A2) {
	        return ((A1 <= b) && (b <= A2));
	    }
	    else {
	        return ((A1 <= b) && (b <= Math.PI)) || ((-Math.PI <= b) && (b <= A2));
	    }
	}

	function normalize(x) {
	    if (x > Math.PI) {
	        return -(2 * Math.PI - x);
	    }
	    else if ( x < -Math.PI) {
	        return 2 * Math.PI + x;
	    }
	    else {
	        return x;
	    }
	}

	function diff(A1, A2) {
	    if (A1 > 0 && A2 < 0) { // A1 in bottom half, A2 in top half
	        return Math.abs((Math.PI - A1) - (-Math.PI - A2));
	    }
	    else if (A2 > 0 && A1 < 0) { // A1 in top half, A2 in bottom half
	        return Math.abs(-A1 + A2);
	    }
	    if (A1 <= 0 && A2 <= 0) { // A1,A2 in bottom half
	        if (isAfter(A1, A2)) { // A1 after A2
	            return -A1 + Math.PI - (-Math.PI - A2)
	        }
	        else {
	            return Math.abs(A2 - A1);
	        }
	    }
	    else {
	        if (isAfter(A1, A2)) {
	            return Math.PI + (Math.PI - A1) + A2
	        }
	        else {
	            return Math.abs(A2 - A1);
	        }
	    }
	}

	function diff_sum(SHADOWS) {
	    var sum = 0;
	    for (var i = 0; i < SHADOWS.length; i++) {
	        ////console.log(SHADOWS[i][0], SHADOWS[i][1], diff(SHADOWS[i][0], SHADOWS[i][1]));
	        sum += diff(SHADOWS[i][0], SHADOWS[i][1]);
	    }
	    return sum;
	}

	rot6 = ROT;
	return rot6;
}

var visionSimulation;
var hasRequiredVisionSimulation;

function requireVisionSimulation () {
	if (hasRequiredVisionSimulation) return visionSimulation;
	hasRequiredVisionSimulation = 1;
	var ImageHandler = requireImageHandler();
	var ROT = requireRot6();

	var key2pt_cache = {};
	function key2pt(key) {
	    if (key in key2pt_cache) return key2pt_cache[key];
	    var p = key.split(',').map(function (c) { return parseInt(c) });
	    var pt = {x: p[0], y: p[1], key: key};
	    key2pt_cache[key] = pt;
	    return pt;
	}

	function xy2key(x, y) {
	    return x + "," + y;
	}

	function xy2pt(x, y) {
	    return {x: x, y: y, key: x + "," + y};
	}

	function pt2key(pt) {
	    return pt.x + "," + pt.y;
	}

	function generateElevationWalls(data, elevation) {
	    var t1 = Date.now();
	    var walls = {};
	    for (var key in data) {
	        var pt = data[key];
	        if (pt.z > elevation) {
	            adjLoop:
	            for (var i = -1; i <= 1; i++) {
	                for (var j = -1; j <= 1; j++) {
	                    if (0 !== i || 0 !== j) {
	                        var k = (pt.x + i) + "," + (pt.y + j);
	                        if (data[k] && data[k].z <= elevation) {
	                            walls[pt.key] = pt;
	                            break adjLoop;
	                        }
	                    }
	                }
	            }
	        }
	    }
	    console.log('generateElevationWalls', Date.now() - t1 + 'ms');
	    return walls;
	}

	function setTreeWalls(obj, elevation, tree, tree_elevations, tree_state, tree_blocks) {
	    for (var i in tree) {
	        if (elevation < tree_elevations[i]) {
	            if (tree_state[i]) {
	                //obj[i] = ['tree', tree[i].x, tree[i].y, Math.SQRT2];
	                tree_blocks[i].forEach(function (pt) {
	                    var k = pt.x + "," + pt.y;
	                    obj[k] = (obj[k] || []).concat([['tree', tree[i].x, tree[i].y, Math.SQRT2]]);
	                });
	            }
	        }
	    }
	}

	function parseImage(imageHandler, offset, width, height, pixelHandler) {
	    var grid = {};
	    imageHandler.scan(offset, width, height, pixelHandler, grid);
	    return grid;
	}

	function VisionSimulation(worlddata, opts) {
	    var self = this;

	    this.opts = opts || {};
	    this.radius = this.opts.radius || parseInt(1600 / 64);
	    this.worldMinX = worlddata.worldMinX;
	    this.worldMinY = worlddata.worldMinY;
	    this.worldMaxX = worlddata.worldMaxX;
	    this.worldMaxY = worlddata.worldMaxY;
	    this.worldWidth = this.worldMaxX - this.worldMinX;
	    this.worldHeight = this.worldMaxY - this.worldMinY;
	    this.gridWidth = this.worldWidth / 64 + 1;
	    this.gridHeight = this.worldHeight / 64 + 1;
	    this.ready = false;

	    this.lightPassesCallback = function (x, y) {
	        var key = x + ',' + y;
	        return !(key in self.elevationWalls[self.elevation]) && !(key in self.ent_fow_blocker_node) && !(key in self.treeWalls[self.elevation] && self.treeWalls[self.elevation][key].length > 0) ;
	    };

	    this.fov = new ROT.FOV.PreciseShadowcasting(this.lightPassesCallback, {topology:8});
	}
	VisionSimulation.prototype.initialize = function (mapDataImagePath, onReady) {
	    var self = this;
	    this.ready = false;
	    this.grid = [];
	    this.gridnav = null;
	    this.ent_fow_blocker_node = null;
	    this.tools_no_wards = null;
	    this.elevationValues = [];
	    this.elevationGrid = null;
	    this.elevationWalls = {};
	    this.treeWalls = {};
	    this.tree = {}; // center key to point map
	    this.tree_blocks = {}; // center to corners map
	    this.tree_relations = {}; // corner to center map
	    this.tree_elevations = {};
	    this.tree_state = {};
	    this.walls = {};
	    this.lights = {};
	    this.area = 0;
	    if (this.imageHandler) this.imageHandler.disable();
	    this.imageHandler = new ImageHandler(mapDataImagePath);
	    var t1 = Date.now();
	    this.imageHandler.load(function (err) {
	        if (!err) {
	            var t2 = Date.now();
	            console.log('image load', t2 - t1 + 'ms');
	            self.gridnav = parseImage(self.imageHandler, self.gridWidth * 2, self.gridWidth, self.gridHeight, self.blackPixelHandler.bind(self));
	            self.ent_fow_blocker_node = parseImage(self.imageHandler, self.gridWidth * 3, self.gridWidth, self.gridHeight, self.blackPixelHandler.bind(self));
	            self.tools_no_wards = parseImage(self.imageHandler, self.gridWidth * 4, self.gridWidth, self.gridHeight, self.blackPixelHandler.bind(self));
	            parseImage(self.imageHandler, self.gridWidth, self.gridWidth, self.gridHeight, self.treeElevationPixelHandler.bind(self));
	            self.elevationGrid = parseImage(self.imageHandler, 0, self.gridWidth, self.gridHeight, self.elevationPixelHandler.bind(self));
	            var t3 = Date.now();
	            console.log('image process', t3 - t2 + 'ms');
	            self.elevationValues.forEach(function (elevation) {
	                //self.elevationWalls[elevation] = generateElevationWalls(self.elevationGrid, elevation);
	                self.treeWalls[elevation] = {};
	                setTreeWalls(self.treeWalls[elevation], elevation, self.tree, self.tree_elevations, self.tree_state, self.tree_blocks);
	            });
	            var t4 = Date.now();
	            console.log('walls generation', t4 - t3 + 'ms');
	            for (var i = 0; i < self.gridWidth; i++) {
	                self.grid[i] = [];
	                for (var j = 0; j < self.gridHeight; j++) {
	                    var pt = xy2pt(i, j);
	                    key2pt_cache[pt.key] = pt;
	                    self.grid[i].push(pt);
	                }
	            }
	            var t5 = Date.now();
	            console.log('cache prime', t5 - t4 + 'ms');
	            self.ready = true;
	        }
	        onReady(err);
	    });
	};

	VisionSimulation.prototype.blackPixelHandler = function (x, y, p, grid) {
	    var pt = this.ImageXYtoGridXY(x, y);
	    if (p[0] === 0) {
	        grid[pt.x + "," + pt.y] = pt;
	    }
	};
	VisionSimulation.prototype.elevationPixelHandler = function (x, y, p, grid) {
	    var pt = this.ImageXYtoGridXY(x, y);
	    pt.z = p[0];
	    grid[pt.x + "," + pt.y] = pt;
	    if (this.elevationValues.indexOf(p[0]) == -1) {
	        this.elevationValues.push(p[0]);
	    }
	};
	VisionSimulation.prototype.treeElevationPixelHandler = function (x, y, p, grid) {
	    var self = this;
	    var pt = this.ImageXYtoGridXY(x, y);
	    if (p[1] == 0 && p[2] == 0) {
	        // trees are 2x2 in grid
	        // tree origins rounded up when converted to grid, so they represent top right corner. subtract 0.5 to get grid origin
	        var treeOrigin = xy2pt(pt.x - 0.5, pt.y - 0.5);
	        var treeElevation = p[0] + 40;
	        var kC = treeOrigin.key;
	        this.tree[kC] = treeOrigin;
	        this.tree_elevations[kC] = treeElevation;
	        this.tree_blocks[kC] = [];
	        this.tree_state[kC] = true;
	        // iterate through tree 2x2 by taking floor and ceil of tree grid origin
	        [Math.floor, Math.ceil].forEach(function (i) {
	            [Math.floor, Math.ceil].forEach(function (j) {
	                var treeCorner = xy2pt(i(treeOrigin.x), j(treeOrigin.y));
	                self.tree_relations[treeCorner.key] = (self.tree_relations[treeCorner.key] || []).concat(treeOrigin);
	                self.tree_blocks[kC].push(treeCorner);
	            });
	        });
	    }
	};
	VisionSimulation.prototype.updateVisibility = function (gX, gY, radius) {
	    var self = this,
	        key = xy2key(gX, gY);

	    radius = radius || self.radius;
	    this.elevation = this.elevationGrid[key].z;
	    this.walls = this.treeWalls[this.elevation];
	    if (!this.elevationWalls[this.elevation]) this.elevationWalls[this.elevation] = generateElevationWalls(this.elevationGrid, this.elevation);
	    //setElevationWalls(this.walls, this.elevationWalls, this.elevation)
	    //setWalls(this.walls, this.ent_fow_blocker_node);
	    //setWalls(this.walls, this.tools_no_wards);
	    //setTreeWalls(this.walls, this.elevation, this.tree, this.tree_elevations, this.tree_state, this.tree_blocks);

	    this.fov.walls = this.walls;
	    this.lights = {};
	    this.area = this.fov.compute(gX, gY, radius, function(x2, y2, r, vis) {
	        var key = xy2key(x2, y2);
	        if (!self.elevationGrid[key]) return;
	        var treePts = self.tree_relations[key];
	        var treeBlocking = false;
	        if (treePts) {
	            for (var i = 0; i < treePts.length; i++) {
	                var treePt = treePts[i];
	                treeBlocking = self.tree_state[treePt.key] && self.tree_elevations[treePt.key] > self.elevation;
	                if (treeBlocking) break;
	            }
	        }
	        if (vis == 1 && !self.ent_fow_blocker_node[key] && !treeBlocking) {
	            self.lights[key] = 255;
	        }
	    });
	    this.lightArea = Object.keys(this.lights).length;
	};

	VisionSimulation.prototype.isValidXY = function (x, y, bCheckGridnav, bCheckToolsNoWards, bCheckTreeState) {
	    if (!this.ready) return false;

	    var key = xy2key(x, y),
	        treeBlocking = false;

	    if (bCheckTreeState) {
	        var treePts = this.tree_relations[key];
	        if (treePts) {
	            for (var i = 0; i < treePts.length; i++) {
	                var treePt = treePts[i];
	                treeBlocking = this.tree_state[treePt.key];
	                if (treeBlocking) break;
	            }
	        }
	    }

	    return x >= 0 && x < this.gridWidth && y >= 0 && y < this.gridHeight && (!bCheckGridnav || !this.gridnav[key]) && (!bCheckToolsNoWards || !this.tools_no_wards[key]) && (!bCheckTreeState || !treeBlocking);
	};

	VisionSimulation.prototype.toggleTree = function (x, y) {
	    var self = this;
	    var key = xy2key(x, y);
	    var isTree = !!this.tree_relations[key];
	    if (isTree) {
	        var treePts = this.tree_relations[key];
	        for (var i = 0; i < treePts.length; i++) {
	            var pt = treePts[i];
	            this.tree_state[pt.key] = !this.tree_state[pt.key];

	            this.elevationValues.forEach(function (elevation) {
	                if (elevation < self.tree_elevations[pt.key]) {
	                    self.tree_blocks[pt.key].forEach(function (ptB) {
	                        for (var j = self.treeWalls[elevation][ptB.key].length - 1; j >= 0; j--) {
	                            if (pt.x == self.treeWalls[elevation][ptB.key][j][1] && pt.y == self.treeWalls[elevation][ptB.key][j][2]) {
	                                self.treeWalls[elevation][ptB.key].splice(j, 1);
	                            }
	                        }
	                    });
	                    if (self.tree_state[pt.key]) {
	                        self.tree_blocks[pt.key].forEach(function (ptB) {
	                            self.treeWalls[elevation][ptB.key] = (self.treeWalls[elevation][ptB.key] || []).concat([['tree', pt.x, pt.y, Math.SQRT2]]);
	                        });
	                    }
	                }
	            });
	        }
	    }

	    return isTree;
	};
	VisionSimulation.prototype.setRadius = function (r) {
	    this.radius = r;
	};
	VisionSimulation.prototype.WorldXYtoGridXY = function (wX, wY, bNoRound) {
	    var x = (wX - this.worldMinX) / 64,
	        y = (wY - this.worldMinY) / 64;
	    if (!bNoRound) {
	        x = parseInt(Math.round(x));
	        y = parseInt(Math.round(y));
	    }
	    return {x: x, y: y, key: x + ',' + y};
	};
	VisionSimulation.prototype.GridXYtoWorldXY = function (gX, gY) {
	    return {x: gX * 64 + this.worldMinX, y: gY * 64 + this.worldMinY};
	};

	VisionSimulation.prototype.GridXYtoImageXY = function (gX, gY) {
	    return {x: gX, y: this.gridHeight - gY - 1};
	};

	VisionSimulation.prototype.ImageXYtoGridXY = function (x, y) {
	    var gY = this.gridHeight - y - 1;
	    return {x: x, y: gY, key: x + ',' + gY};
	};

	VisionSimulation.prototype.WorldXYtoImageXY = function (wX, wY) {
	    var pt = this.WorldXYtoGridXY(wX, wY);
	    return this.GridXYtoImageXY(pt.x, pt.y);
	};

	VisionSimulation.prototype.key2pt = key2pt;
	VisionSimulation.prototype.xy2key = xy2key;
	VisionSimulation.prototype.xy2pt = xy2pt;
	VisionSimulation.prototype.pt2key = pt2key;

	visionSimulation = VisionSimulation;
	return visionSimulation;
}

var visionSimulationExports = requireVisionSimulation();
var VisionSimulation = /*@__PURE__*/getDefaultExportFromCjs(visionSimulationExports);

// dota-vision-simulation reuses its FOV instance, but leaves this completion
// flag set after shadowcasting exits early. Clear it before every new source.
function resetVisionSearchState(visionSimulation) {
    if (visionSimulation?.fov) visionSimulation.fov.done = false;
}

function signedArea(ring) {
    return ring.slice(0, -1).reduce((area, point, i) => (
        area + point[0] * ring[i + 1][1] - ring[i + 1][0] * point[1]
    ), 0) / 2;
}

function containsPoint([x, y], ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
        j = i;
    }
    return inside;
}

// Trace exposed cell edges. Keeping the blocked cell on the left preserves
// holes and separates islands which only touch at a corner.
function gridToPolygons(grid) {
    const { width, height, cellSize, origin, blockedRows } = grid;
    const mask = new Uint8Array(width * height);
    blockedRows.forEach((spans, y) => {
        for (let i = 0; i < spans.length; i += 2) mask.fill(1, y * width + spans[i], y * width + spans[i + 1]);
    });
    const edges = [];
    const outgoing = new Map();
    const has = (x, y) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x];
    const add = (sx, sy, ex, ey, direction) => {
        const key = sy * (width + 1) + sx;
        if (!outgoing.has(key)) outgoing.set(key, []);
        outgoing.get(key).push(edges.length);
        edges.push({ sx, sy, ex, ey, direction, used: false });
    };
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (!has(x, y)) continue;
            if (!has(x, y - 1)) add(x, y, x + 1, y, 0);
            if (!has(x + 1, y)) add(x + 1, y, x + 1, y + 1, 1);
            if (!has(x, y + 1)) add(x + 1, y + 1, x, y + 1, 2);
            if (!has(x - 1, y)) add(x, y + 1, x, y, 3);
        }
    }
    const loops = [];
    const rank = [1, 0, 3, 2]; // left turn, straight, right turn, reverse
    for (const first of edges) {
        if (first.used) continue;
        const ring = [];
        let edge = first;
        while (true) {
            if (edge.used) throw new Error('Invalid grid contour.');
            edge.used = true;
            ring.push([origin[0] + edge.sx * cellSize, origin[1] + edge.sy * cellSize]);
            if (edge.ex === first.sx && edge.ey === first.sy) break;
            const candidates = outgoing.get(edge.ey * (width + 1) + edge.ex)
                .map(index => edges[index]).filter(candidate => !candidate.used);
            candidates.sort((a, b) => rank[(a.direction - edge.direction + 4) % 4]
                - rank[(b.direction - edge.direction + 4) % 4]);
            if (!candidates.length) throw new Error('Open grid contour.');
            [edge] = candidates;
        }
        // Remove collinear vertices without changing a single cell boundary.
        const corners = ring.filter((point, i) => {
            const previous = ring[(i + ring.length - 1) % ring.length];
            const next = ring[(i + 1) % ring.length];
            return (point[0] - previous[0]) * (next[1] - point[1])
                !== (point[1] - previous[1]) * (next[0] - point[0]);
        });
        corners.push(corners[0]);
        loops.push(corners);
    }
    const polygons = loops.filter(ring => signedArea(ring) > 0)
        .map(ring => ({ rings: [ring], area: signedArea(ring) })).sort((a, b) => a.area - b.area);
    for (const hole of loops.filter(ring => signedArea(ring) < 0)) {
        const [[x1, y1], [x2, y2]] = hole;
        const length = Math.hypot(x2 - x1, y2 - y1);
        const interior = [(x1 + x2) / 2 + (y2 - y1) / length * cellSize / 4, (y1 + y2) / 2 - (x2 - x1) / length * cellSize / 4];
        const owner = polygons.find(polygon => containsPoint(interior, polygon.rings[0]));
        if (!owner) throw new Error('Grid contour hole has no enclosing polygon.');
        owner.rings.push(hole);
    }
    return polygons.map(polygon => polygon.rings);
}

// Trace every lit cell: separate islands are polygons, enclosed shadows holes.
const getLightUnion = (grid, lights) => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const key of Object.keys(lights)) {
        if (!lights[key]) continue;
        const [x, y] = key.split(',').map(Number);
        if (!grid[x]?.[y]) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    }
    if (!Number.isFinite(minX)) return [];
    const blockedRows = [];
    for (let y = minY; y <= maxY; y++) {
        const spans = [];
        let start = -1;
        for (let x = minX; x <= maxX + 1; x++) {
            const lit = x <= maxX && !!lights[`${x},${y}`];
            if (lit && start === -1) start = x - minX;
            if (!lit && start !== -1) {
                spans.push(start, x - minX);
                start = -1;
            }
        }
        blockedRows.push(spans);
    }
    return gridToPolygons({ width: maxX - minX + 1, height: maxY - minY + 1,
        cellSize: 1, origin: [minX - 0.5, minY - 0.5], blockedRows });
};

export { VisionSimulation, VisionSimulation as default, getLightUnion, resetVisionSearchState };
