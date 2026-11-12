import app from './../app.js';
import config from './../config.js';
import Base_tools_class from './../core/base-tools.js';
import Base_layers_class from './../core/base-layers.js';

class Brush_class extends Base_tools_class {

	constructor(ctx) {
		super();
		this.Base_layers = new Base_layers_class();
		this.name = 'brush';
		this.layer = {};
		this.params_hash = false;
		this.pressure_supported = false;
		this.pointer_pressure = 0; // has range [0 - 1]
		this.max_speed = 20;
		this.power = 2; //how speed affects size
		this.gesture = null;
		this.pointer_coordinates = null;
	}

	load() {
		var _this = this;
		var is_touch = false;

		//pointer events
		document.addEventListener('pointerdown', function (event) {
			_this.pointerdown(event);
		});
		document.addEventListener('pointermove', function (event) {
			_this.pointermove(event);
		});

		//mouse events
		document.addEventListener('mousedown', function (event) {
			if(is_touch)
				return;
			_this.dragStart(event);
		});
		document.addEventListener('mousemove', function (event) {
			if(is_touch)
				return;
			_this.dragMove(event);
		});
		document.addEventListener('mouseup', function (event) {
			if(is_touch)
				return;
			_this.dragEnd(event);
		});

		// collect touch events
		document.addEventListener('touchstart', function (event) {
			is_touch = true;
			_this.dragStart(event);
		});
		document.addEventListener('touchmove', function (event) {
			_this.dragMove(event);
		});
		document.addEventListener('touchend', function (event) {
			_this.dragEnd(event);
		});
		document.addEventListener('touchcancel', function () {
			_this.finish_gesture();
		});
		window.addEventListener('blur', function () {
			_this.finish_gesture();
		});
	}

	pointerdown(e) {
		this.cache_pointer_coordinates(e, 'mousedown');
		// Devices that don't actually support pen pressure can give 0.5 as a false reading.
		// It is highly unlikely a real pen will read exactly 0.5 at the start of a stroke.
		if (e.pressure && e.pressure !== 0 && e.pressure !== 0.5 && e.pressure <= 1) {
			this.pressure_supported = true;
			this.pointer_pressure = e.pressure;
		} else {
			this.pressure_supported = false;
		}
	}

	pointermove(e) {
		this.cache_pointer_coordinates(e, 'mousemove');
		// Pressure of exactly 1 seems to be an input error, sometimes I see it when lifting the pen
		// off the screen when pressure reading should be near 0.
		if (this.pressure_supported && e.pressure < 1) {
			this.pointer_pressure = e.pressure;
		}
	}

	cache_pointer_coordinates(e, mouse_type) {
		this.pointer_coordinates = null;
		if ((e.pointerType === 'mouse' || e.pointerType === 'pen') && e.isPrimary !== false &&
			Number.isFinite(e.pageX) && Number.isFinite(e.pageY) && Number.isFinite(e.timeStamp)) {
			this.pointer_coordinates = {
				type: mouse_type,
				pageX: e.pageX,
				pageY: e.pageY,
				timeStamp: e.timeStamp,
				target: e.target
			};
		}
	}

	get_stroke_coordinates(e) {
		const pointer = this.pointer_coordinates;
		if (pointer && e.identifier == null && pointer.type === e.type &&
			pointer.timeStamp === e.timeStamp && pointer.target === e.target) {
			this.pointer_coordinates = null;
			// Chromium rounds compatibility MouseEvent coordinates to whole screen pixels.
			// Use its paired precise PointerEvent for symmetry, retaining the original Off path.
			if (this.gesture.mode !== 'Off')
				return this.get_mouse_coordinates_from_event(pointer);
		}
		return this.get_mouse_coordinates_from_event(e);
	}

	dragStart(event) {
		if (config.TOOL.name != this.name)
			return;
		var mouse = this.get_mouse_info(event);
		if (!mouse.is_drag || !mouse.click_valid)
			return;

		// A new mouse press also recovers from a release outside the window.
		if (!event.changedTouches && this.gesture)
			this.finish_gesture();
		const events = event.changedTouches || [event];
		for (const e of events) {
			this.mousedown_action(e, null, e.identifier == null ? null : e.identifier);
		}
	}

	dragMove(event) {
		if (config.TOOL.name != this.name)
			return;
		if (!event.changedTouches) {
			const mouse = this.get_mouse_info(event);
			const params = this.gesture ? this.gesture.params : this.getParams();
			this.show_mouse_cursor(mouse.x, mouse.y, params.size, 'circle');
		}
		const events = event.changedTouches || [event];
		for (const e of events) {
			this.mousemove_action(e);
		}
	}

	dragEnd(event) {
		if (!this.gesture)
			return;
		const events = event.changedTouches || [event];
		for (const e of events) {
			this.mouseup_action(e);
		}
	}

	get_symmetry_mode() {
		const setting = this.getParams().symmetry;
		const mode = setting && typeof setting === 'object' ? setting.value : setting;
		return ['Vertical', 'Horizontal', 'Both'].includes(mode) ? mode : 'Off';
	}

	get_symmetry_transforms(mode) {
		// Bit 1 reflects x (a vertical axis); bit 2 reflects y.
		if (mode === 'Vertical') return [0, 1];
		if (mode === 'Horizontal') return [0, 2];
		if (mode === 'Both') return [0, 1, 2, 3];
		return [0];
	}

	is_current_gesture() {
		const gesture = this.gesture;
		return gesture && config.layer === gesture.layer &&
			gesture.layer.data === gesture.data &&
			gesture.layer.x === gesture.x && gesture.layer.y === gesture.y;
	}

	mousedown_action(e, index, event_identifier) {
		const mouse = this.get_mouse_info(e);
		if (!mouse.click_valid)
			return;
		if (this.gesture && !this.is_current_gesture())
			this.finish_gesture();

		if (!this.gesture) {
			const params_hash = this.get_params_hash();
			const mode = this.get_symmetry_mode();
			const params = this.clone(this.getParams());
			// The stored paths already contain the reflection. It is not a layer effect.
			delete params.symmetry;
			let settings;
			let action;
			if (config.layer.type !== this.name || params_hash !== this.params_hash ||
				config.layer.color !== config.COLOR ||
				JSON.stringify(config.layer.params) !== JSON.stringify(params)) {
				settings = {
					type: this.name,
					data: [],
					params,
					status: 'draft',
					render_function: [this.name, 'render'],
					x: 0,
					y: 0,
					width: config.WIDTH,
					height: config.HEIGHT,
					hide_selection_if_active: true,
					rotate: null,
					is_vector: true,
					color: config.COLOR
				};
				action = new app.Actions.Bundle_action('new_brush_layer', 'New Brush Layer', [
					new app.Actions.Insert_layer_action(settings)
				]);
			} else {
				settings = {
					data: this.clone(this.check_legacy_format(config.layer.data)),
					x: config.layer.x,
					y: config.layer.y,
					width: config.layer.width,
					height: config.layer.height,
					status: 'draft'
				};
				action = new app.Actions.Bundle_action('update_brush_layer', 'Update Brush Layer', [
					new app.Actions.Update_layer_action(config.layer.id, settings)
				]);
			}
			// Insert/Update installs the draft synchronously; the same settings object
			// receives the final bounds so undo/redo keeps the entire gesture atomic.
			app.State.do_action(action);
			this.params_hash = params_hash;
			this.gesture = {
				layer: config.layer,
				data: config.layer.data,
				x: config.layer.x,
				y: config.layer.y,
				width: config.WIDTH,
				height: config.HEIGHT,
				mode,
				params: this.clone(params),
				settings,
				contacts: new Map()
			};
		}

		const gesture = this.gesture;
		const identifier = event_identifier == null ? null : event_identifier;
		if (gesture.contacts.has(identifier))
			return;
		const transforms = this.get_symmetry_transforms(gesture.mode);
		const contact = {
			transforms,
			paths: transforms.map(() => []),
			indices: transforms.map(() => gesture.data.push([]) - 1),
			on_vertical_axis: true,
			on_horizontal_axis: true
		};
		gesture.contacts.set(identifier, contact);
		this.append_stroke_point(e, contact);
	}

	append_stroke_point(e, contact) {
		const gesture = this.gesture;
		const mouse = this.get_mouse_info(e);
		const params = gesture.params;
		let size = params.size;
		if (params.pressure === true) {
			if (this.pressure_supported) {
				size = size * this.pointer_pressure * 2;
			} else {
				size += size / this.max_speed * mouse.speed_average * this.power;
				size = Math.round(Math.max(size, params.size / 4));
			}
		}

		const point = this.get_stroke_coordinates(e);
		// Zoom inversion can place a mathematical center a few floating-point ulps off-axis.
		// This tolerance only classifies duplicate paths; it never snaps stored coordinates.
		const axis_epsilon = 1e-7;
		contact.on_vertical_axis = contact.on_vertical_axis && Math.abs(point.x - gesture.width / 2) <= axis_epsilon;
		contact.on_horizontal_axis = contact.on_horizontal_axis && Math.abs(point.y - gesture.height / 2) <= axis_epsilon;
		const identical_axes = (contact.on_vertical_axis ? 1 : 0) | (contact.on_horizontal_axis ? 2 : 0);
		const seen = new Set();
		for (let i = 0; i < contact.transforms.length; i++) {
			const transform = contact.transforms[i];
			const x = transform & 1 ? gesture.width - point.x : point.x;
			const y = transform & 2 ? gesture.height - point.y : point.y;
			contact.paths[i].push([x - gesture.x, y - gesture.y, size]);
			const unique_transform = transform & ~identical_axes;
			// Keep the complete hidden path: a later point can leave an axis.
			// Deduplicating individual points would break a crossing stroke.
			gesture.data[contact.indices[i]] = seen.has(unique_transform) ? [] : contact.paths[i];
			seen.add(unique_transform);
		}
		this.Base_layers.render();
	}

	mousemove_action(e) {
		if (!this.gesture)
			return;
		if (!this.is_current_gesture()) {
			this.finish_gesture();
			return;
		}
		const mouse = this.get_mouse_info(e);
		if (!mouse.is_drag || !mouse.click_valid)
			return;
		const identifier = e.identifier == null ? null : e.identifier;
		const contact = this.gesture.contacts.get(identifier);
		if (contact)
			this.append_stroke_point(e, contact);
	}

	mouseup_action(e) {
		if (!this.gesture)
			return;
		const identifier = e.identifier == null ? null : e.identifier;
		this.gesture.contacts.delete(identifier);
		if (this.gesture.contacts.size === 0 || !this.is_current_gesture())
			this.finish_gesture();
	}

	finish_gesture() {
		const gesture = this.gesture;
		if (!gesture)
			return;
		this.gesture = null;
		const attached = config.layers.includes(gesture.layer) && gesture.layer.data === gesture.data;
		const moved = attached && (gesture.layer.x !== gesture.x || gesture.layer.y !== gesture.y);
		// An intervening move owns its coordinates; rebasing now would change its undo/redo result.
		const bounds = moved ? {data: gesture.data} : this.check_dimensions(gesture.data, gesture.x, gesture.y);
		const settings = Object.assign({status: null}, bounds);
		Object.assign(gesture.settings, settings);
		// Undo, project loading or layer deletion may have detached this draft.
		// Never write into the new selection or overwrite a newer layer edit.
		if (attached && !moved) {
			Object.assign(gesture.layer, settings);
		} else if (attached) {
			gesture.layer.status = null;
		}
		this.Base_layers.render();
	}

	on_params_update() {
		config.need_render = true;
	}

	on_leave() {
		this.finish_gesture();
		return [];
	}

	render_overlay(ctx) {
		const gesture = this.is_current_gesture() ? this.gesture : null;
		const mode = gesture ? gesture.mode : this.get_symmetry_mode();
		if (mode === 'Off')
			return;
		const width = gesture ? gesture.width : config.WIDTH;
		const height = gesture ? gesture.height : config.HEIGHT;
		const zoom = config.ZOOM || 1;
		ctx.save();
		ctx.beginPath();
		ctx.rect(0, 0, width, height);
		ctx.clip();
		ctx.globalCompositeOperation = 'source-over';
		ctx.globalAlpha = 0.5;
		ctx.filter = 'none';
		ctx.shadowBlur = 0;
		ctx.strokeStyle = '#00a6a6';
		ctx.lineWidth = 1 / zoom;
		ctx.setLineDash([4 / zoom, 4 / zoom]);
		ctx.beginPath();
		if (mode === 'Vertical' || mode === 'Both') {
			ctx.moveTo(width / 2, 0);
			ctx.lineTo(width / 2, height);
		}
		if (mode === 'Horizontal' || mode === 'Both') {
			ctx.moveTo(0, height / 2);
			ctx.lineTo(width, height / 2);
		}
		ctx.stroke();
		ctx.restore();
	}

	render(ctx, layer) {
		if (layer.data.length == 0)
			return;

		var params = layer.params;
		var size = params.size;

		//set styles
		ctx.save();
		ctx.fillStyle = layer.color;
		ctx.strokeStyle = layer.color;
		ctx.lineWidth = params.size;
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';

		ctx.translate(layer.x, layer.y);

		var data = layer.data;

		//check for legacy format
		data = this.check_legacy_format(data);

		var n = data.length;
		for (var k = 0; k < n; k++) {
			var group_data = data[k]; //data from mouse down till mouse release
			var group_n = group_data.length;

			if (params.pressure == false) {
				//stabilized lines method does not support multiple line sizes
				this.render_stabilized(ctx, group_data);
			}
			else {
				if (group_data[0]) {
					ctx.beginPath();
					ctx.moveTo(group_data[0][0], group_data[0][1]);
					for (var i = 1; i < group_n; i++) {
						if (group_data[i] === null) {
							//break
							ctx.beginPath();
						}
						else {
							//line

							ctx.lineWidth = group_data[i][2];

							if (group_data[i - 1] == null && group_data[i + 1] == null) {
								//exception - point
								ctx.arc(group_data[i][0], group_data[i][1], size / 2, 0, 2 * Math.PI, false);
								ctx.fill();
							}
							else if (group_data[i - 1] != null) {
								//lines
								ctx.lineWidth = group_data[i][2];
								ctx.beginPath();
								ctx.moveTo(group_data[i - 1][0], group_data[i - 1][1]);
								ctx.lineTo(group_data[i][0], group_data[i][1]);
								ctx.stroke();
							}
						}
					}
					if (group_data[1] == null) {
						//point
						ctx.beginPath();
						ctx.arc(group_data[0][0], group_data[0][1], size / 2, 0, 2 * Math.PI, false);
						ctx.fill();
					}
				}
			}
		}

		ctx.translate(-layer.x, -layer.y);
		ctx.restore();
	}

	/**
	 * draw stabilized lines
	 * author: Manoj Verma
	 * source: https://stackoverflow.com/questions/7891740/drawing-smooth-lines-with-canvas/44810470#44810470
	 *
	 * @param ctx
	 * @param queue
	 */
	render_stabilized(ctx, queue) {
		var data = JSON.parse(JSON.stringify(queue));
		var n = data.length;

		if (data.length == 1) {
			//point
			var point = data[0];
			ctx.beginPath();
			ctx.arc(point[0], point[1], point[2] / 2, 0, 2 * Math.PI, false);
			ctx.fill();
			return;
		}
		else if (data.length <= 5) {
			//not enough points yet

			for (var i = 1; i < n; i++) {
				ctx.beginPath();
				ctx.moveTo(data[i - 1][0], data[i - 1][1]);
				ctx.lineTo(data[i][0], data[i][1]);
				ctx.stroke();
			}
			return;
		}

		//fix for loose ending, so lets duplicate last point
		data.push([data[n - 1][0], data[n - 1][1]]);

		ctx.beginPath();
		ctx.moveTo(data[0][0], data[0][1]);

		//prepare
		var temp_data1 = [data[0]];
		var c, d;
		for (var i = 1; i < data.length - 1;  i = i+1) {
			c = (data[i][0] + data[i + 1][0]) / 2;
			d = (data[i][1] + data[i + 1][1]) / 2;
			temp_data1.push([c, d]);
		}

		var temp_data2 = [temp_data1[0]];
		for (var i = 1; i < temp_data1.length - 1;  i = i+1) {
			c = (temp_data1[i][0] + temp_data1[i + 1][0]) / 2;
			d = (temp_data1[i][1] + temp_data1[i + 1][1]) / 2;
			temp_data2.push([c, d]);
		}

		var temp_data = [temp_data2[0]];
		for (var i = 1; i < temp_data2.length - 1;  i = i+1) {
			c = (temp_data2[i][0] + temp_data2[i + 1][0]) / 2;
			d = (temp_data2[i][1] + temp_data2[i + 1][1]) / 2;
			temp_data.push([c, d]);
		}

		//draw
		for (var i = 1; i < temp_data.length - 2;  i = i+1) {
			c = (temp_data[i][0] + temp_data[i + 1][0]) / 2;
			d = (temp_data[i][1] + temp_data[i + 1][1]) / 2;
			ctx.quadraticCurveTo(temp_data[i][0], temp_data[i][1], c, d);
		}

		// For the last 2 points
		ctx.quadraticCurveTo(
			temp_data[i][0],
			temp_data[i][1],
			temp_data[i+1][0],
			temp_data[i+1][1]
		);
		ctx.stroke();
	}

	check_legacy_format(data) {
		//check for legacy format
		if(data.length > 0 && typeof data[0][0] == "number"){
			//convert
			var legacy = JSON.parse(JSON.stringify(data));
			data = [];
			data.push([]);
			var group_index = 0;
			for(var i in legacy){
				if(legacy[i] === null){
					data.push([]);
					group_index++;
				}
				else {
					data[group_index].push([legacy[i][0], legacy[i][1], legacy[i][2]]);
				}
			}
		}

		return data;
	}

	/**
	 * Normalize every path into layer-local bounds, including single-click copies.
	 * The result is finalized into the gesture's existing history action.
	 */
	check_dimensions(source, x, y) {
		const data = this.clone(this.check_legacy_format(source)).filter(group => group.length > 0);
		let min_x = Infinity;
		let min_y = Infinity;
		let max_x = -Infinity;
		let max_y = -Infinity;
		for (const group of data) {
			for (const point of group) {
				if (!point) continue;
				min_x = Math.min(min_x, point[0]);
				min_y = Math.min(min_y, point[1]);
				max_x = Math.max(max_x, point[0]);
				max_y = Math.max(max_y, point[1]);
			}
		}
		if (!Number.isFinite(min_x))
			return {data};
		for (const group of data) {
			for (const point of group) {
				if (!point) continue;
				point[0] -= min_x;
				point[1] -= min_y;
			}
		}
		return {x: x + min_x, y: y + min_y, width: max_x - min_x, height: max_y - min_y, data};
	}

}

export default Brush_class;
