#!/usr/bin/env node
'use strict';
// Runs real project code. Only browser/GUI/render scheduling are doubled.
// This harness does not claim Canvas pixel, native pointer, or filesystem I/O coverage.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {transformSync} = require('@babel/core');
const modulesPlugin = require('@babel/plugin-transform-modules-commonjs');
const root = path.resolve(__dirname, '../..');
const results = [];
const json = value => JSON.parse(JSON.stringify(value));

function fixture({mode = 'Off', width = 800, height = 600, zoom = 1, pan = {x: 0, y: 0}, offset = {x: 30, y: 60}, size = 12, pressure = false} = {}) {
  const cache = new Map(), listeners = new Map(), pending = [], notices = [];
  let config;
  const mouseElement = {style: {}, className: '', classList: {add() {}}};
  global.window = {performance: {}, addEventListener() {}};
  global.document = {
    addEventListener(type, fn) { const list = listeners.get(type) || []; list.push(fn); listeners.set(type, list); },
    getElementById() { return mouseElement; },
  };
  class LayersDouble {
    constructor() { return layers; }
  }
  const layers = {
    auto_increment: 2,
    render() { if (config) config.need_render = true; },
    get_layer(id) { return config.layers.find(layer => layer.id === id); },
    get_world_coords(x, y) { return {x: (x - pan.x) / zoom, y: (y - pan.y) / zoom}; },
  };
  class GuiDouble {
    constructor() { this.canvas_offset = offset; this.GUI_layers = {render_layers() {}}; }
  }
  class HelperDouble { is_input() { return false; } }
  const stubs = new Map([
    [path.join(root, 'src/js/core/base-layers.js'), LayersDouble],
    [path.join(root, 'src/js/core/base-gui.js'), GuiDouble],
    [path.join(root, 'src/js/libs/helpers.js'), HelperDouble],
    [path.join(root, 'node_modules/alertifyjs/build/alertify.min.js'), {error(message) { notices.push({level: 'error', message}); }, success(message) { notices.push({level: 'success', message}); }}],
  ]);
  function load(file) {
    file = path.resolve(root, file);
    if (!path.extname(file)) file += '.js';
    if (stubs.has(file)) return {__esModule: true, default: stubs.get(file)};
    if (cache.has(file)) return cache.get(file).exports;
    const module = {exports: {}};
    cache.set(file, module);
    const code = transformSync(fs.readFileSync(file, 'utf8'), {filename: file, configFile: false, babelrc: false, plugins: [modulesPlugin]}).code;
    const localRequire = spec => spec.startsWith('.') ? load(path.resolve(path.dirname(file), spec)) : require(spec);
    new Function('require', 'module', 'exports', code)(localRequire, module, module.exports);
    return module.exports;
  }
  config = load('src/js/config.js').default;
  Object.assign(config, {WIDTH: width, HEIGHT: height, ZOOM: zoom, COLOR: '#1769e0', ALPHA: 255, mouse: {x: 0, y: 0, is_drag: true, click_valid: true, valid: true, speed_average: 0}});
  config.TOOL = config.TOOLS.find(tool => tool.name === 'brush');
  assert.ok(config.TOOL.attributes.symmetry, 'symmetry setting must be implemented before this suite runs');
  config.TOOL.attributes.symmetry.value = mode;
  config.TOOL.attributes.size = size;
  config.TOOL.attributes.pressure = pressure;
  config.layer = {id: 1, name: 'Empty', type: null, data: null, x: 0, y: 0, width: null, height: null, opacity: 100, params: {}, color: '#1769e0'};
  config.layers = [config.layer];
  global.mouse = config.mouse; // Existing Base_tools references a global mouse before returning config.mouse.
  const app = load('src/js/app.js').default;
  app.Config = config;
  app.Layers = layers;
  app.GUI = new GuiDouble();
  app.Actions = {
    ...load('src/js/actions/base.js'),
    ...load('src/js/actions/bundle.js'),
    ...load('src/js/actions/update-layer.js'),
    ...load('src/js/actions/insert-layer.js'),
  };
  const State = load('src/js/core/base-state.js').default;
  app.State = new State();
  const realDo = app.State.do_action.bind(app.State);
  app.State.do_action = (...args) => { const result = realDo(...args); pending.push(result); return result; };
  const Brush = load('src/js/tools/brush.js').default;
  const brush = new Brush();
  const flush = async () => {
    while (pending.length) {
      const batch = pending.splice(0);
      for (const result of await Promise.all(batch)) assert.notEqual(result?.status, 'aborted', String(result?.reason));
    }
  };
  function event(x, y, extra = {}) {
    Object.assign(config.mouse, {x, y, is_drag: true, click_valid: true, valid: true});
    return {pageX: x * zoom + pan.x + offset.x, pageY: y * zoom + pan.y + offset.y, target: {id: 'canvas_minipaint'}, which: 1, preventDefault() {}, ...extra};
  }
  async function stroke(points, {beforeMove, afterStart} = {}) {
    const first = event(...points[0]);
    brush.dragStart({...first, type: 'mousedown'});
    await flush();
    if (afterStart) await afterStart();
    for (let index = 1; index < points.length; index++) {
      if (beforeMove) beforeMove(index);
      brush.dragMove({...event(...points[index]), type: 'mousemove'});
      await flush();
    }
    const last = event(...points[points.length - 1]);
    config.mouse.is_drag = false;
    brush.dragEnd({...last, type: 'mouseup'});
    await flush();
    return config.layer;
  }
  return {config, app, brush, layers, flush, event, stroke, notices, listeners, load};
}

function worldGroups(layer) {
  return layer.data.filter(group => group?.length).map(group => group.map(point => [point[0] + layer.x, point[1] + layer.y, point[2]]));
}
function canonical(groups) { return [...groups].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))); }
function close(actual, expected, message = '') {
  if (Array.isArray(expected)) { assert.equal(actual.length, expected.length, message); expected.forEach((entry, i) => close(actual[i], entry, message)); }
  else if (typeof expected === 'number') assert.ok(Math.abs(actual - expected) < 1e-8, `${message}: ${actual} != ${expected}`);
  else assert.equal(actual, expected, message);
}
async function test(name, run) {
  const started = process.hrtime.bigint();
  try { await run(); results.push({name, passed: true, milliseconds: Number(process.hrtime.bigint() - started) / 1e6}); console.log(`PASS ${name}`); }
  catch (error) { results.push({name, passed: false, error: error.stack}); console.error(`FAIL ${name}\n${error.stack}`); }
}

(async () => {
  for (const [mode, multipliers] of [['Off', [[1,1]]], ['Vertical', [[1,1],[-1,1]]], ['Horizontal',[[1,1],[1,-1]]], ['Both',[[1,1],[-1,1],[1,-1],[-1,-1]]]]) {
    await test(`${mode} uses continuous document coordinates and identical widths`, async () => {
      const f = fixture({mode});
      const points = [[100.5,90.25],[150.25,110.5],[220.5,160.25]];
      const layer = await f.stroke(points);
      const expected = multipliers.map(([sx,sy]) => points.map(([x,y])=>[sx === 1 ? x : 800-x,sy === 1 ? y : 600-y,12]));
      close(canonical(worldGroups(layer)), canonical(expected));
      assert.equal(layer.color, '#1769e0');
    });
  }
  await test('Both mirrors an odd-sized canvas about its half-pixel center', async () => {
    const f = fixture({mode:'Both',width:801,height:603});
    const layer = await f.stroke([[0.25,0.5],[80.25,100.5]]);
    close(canonical(worldGroups(layer)), canonical([
      [[0.25,0.5,12],[80.25,100.5,12]], [[800.75,0.5,12],[720.75,100.5,12]],
      [[0.25,602.5,12],[80.25,502.5,12]], [[800.75,602.5,12],[720.75,502.5,12]],
    ]));
  });
  await test('Input conversion works with zoom, pan and page offset', async () => {
    const f = fixture({mode:'Vertical',zoom:2.5,pan:{x:42,y:-75},offset:{x:143,y:99}});
    const layer = await f.stroke([[20.25,35.75],[300.5,100.25]]);
    close(canonical(worldGroups(layer)), canonical([[[20.25,35.75,12],[300.5,100.25,12]],[[779.75,35.75,12],[499.5,100.25,12]]]));
  });
  await test('Both single-click dots include all points in layer bounds', async () => {
    const f = fixture({mode:'Both'}), layer = await f.stroke([[100,80]]);
    close([layer.x,layer.y,layer.width,layer.height],[100,80,600,440]);
    close(canonical(worldGroups(layer)),canonical([[[100,80,12]],[[700,80,12]],[[100,520,12]],[[700,520,12]]]));
  });
  await test('Dot on both axes is stored once', async () => {
    const f = fixture({mode:'Both'}), layer = await f.stroke([[400,300]]);
    close(worldGroups(layer), [[[400,300,12]]]);
  });
  await test('Path on a vertical axis is not duplicated', async () => {
    const f = fixture({mode:'Vertical'}), layer = await f.stroke([[400,40],[400,110],[400,170]]);
    close(worldGroups(layer), [[[400,40,12],[400,110,12],[400,170,12]]]);
  });
  await test('Both on one axis retains only two distinct paths', async () => {
    const f = fixture({mode:'Both'}), layer = await f.stroke([[400,40],[400,110],[400,170]]);
    assert.equal(worldGroups(layer).length,2);
  });
  await test('Crossing the center retains continuous separate paths', async () => {
    const f = fixture({mode:'Vertical'}), layer = await f.stroke([[300,150],[400,180],[500,220]]);
    close(canonical(worldGroups(layer)),canonical([[[300,150,12],[400,180,12],[500,220,12]],[[500,150,12],[400,180,12],[300,220,12]]]));
  });
  await test('Starting on an axis then leaving it preserves the shared first point', async () => {
    const f = fixture({mode:'Vertical'}), layer = await f.stroke([[400,120],[420,160],[470,180]]);
    close(canonical(worldGroups(layer)),canonical([[[400,120,12],[420,160,12],[470,180,12]],[[400,120,12],[380,160,12],[330,180,12]]]));
  });
  await test('Brush pressure computes once and copies sample widths', async () => {
    const f = fixture({mode:'Both',size:20,pressure:true});
    f.brush.pressure_supported = true; f.brush.pointer_pressure = 0.25;
    const layer = await f.stroke([[100,100],[140,140],[180,100]],{beforeMove(i){f.brush.pointer_pressure = i === 1 ? 0.6 : 0.9;}});
    for (const group of worldGroups(layer)) close(group.map(point=>point[2]),[10,24,36]);
  });
  await test('Moved layer keeps previous data and stores new symmetry in document space', async () => {
    const f = fixture({mode:'Vertical'});
    await f.stroke([[100,70],[150,80]]);
    await f.app.State.do_action(new f.app.Actions.Update_layer_action(f.config.layer.id,{x:f.config.layer.x+65,y:f.config.layer.y-25})); await f.flush();
    const oldData = f.config.layer.data, oldValue = json(oldData), oldWorld = json(worldGroups(f.config.layer));
    const layer = await f.stroke([[60,180],[130,220]]);
    close(worldGroups(layer).slice(0,2),oldWorld);
    close(canonical(worldGroups(layer).slice(2)),canonical([[[60,180,12],[130,220,12]],[[740,180,12],[670,220,12]]]));
    assert.deepEqual(oldData,oldValue,'previous history data must not be mutated');
  });
  await test('A new Both gesture is one real history action and undoes/redoes atomically', async () => {
    const f = fixture({mode:'Both'}), before=json(f.config.layers);
    await f.stroke([[120,80],[160,110]]);
    assert.equal(f.app.State.action_history.length,1);
    const after=json(f.config.layers);
    await f.app.State.undo_action(); assert.deepEqual(json(f.config.layers),before);
    await f.app.State.redo_action(); assert.deepEqual(json(f.config.layers),after);
  });
  await test('Reused-layer gesture has one history step with exact restore', async () => {
    const f = fixture({mode:'Both'});
    await f.stroke([[120,80],[160,110]]); const before=json(f.config.layers);
    await f.stroke([[220,180],[260,210]]); const after=json(f.config.layers);
    assert.equal(f.app.State.action_history.length,2);
    await f.app.State.undo_action(); assert.deepEqual(json(f.config.layers),before);
    await f.app.State.redo_action(); assert.deepEqual(json(f.config.layers),after);
  });
  await test('Undo followed by a new gesture discards the redo branch', async () => {
    const f=fixture({mode:'Vertical'});
    await f.stroke([[100,70],[120,100]]); await f.stroke([[180,200],[190,240]]);
    await f.app.State.undo_action(); await f.stroke([[240,80],[280,120]]);
    assert.equal(f.app.State.can_redo(),false);
    assert.equal(f.app.State.action_history.length,2);
    close(canonical(worldGroups(f.config.layer).slice(2)),canonical([[[240,80,12],[280,120,12]],[[560,80,12],[520,120,12]]]));
  });
  await test('Mode changes start a new layer and leave prior strokes unchanged', async () => {
    const f=fixture({mode:'Vertical'});
    await f.stroke([[80,50],[150,60]]); const old=f.config.layer, oldData=json(old.data);
    f.config.TOOL.attributes.symmetry.value='Horizontal';
    await f.stroke([[120,80],[180,90]]);
    assert.equal(f.config.layers.length,2); assert.deepEqual(old.data,oldData);
    close(canonical(worldGroups(f.config.layer)),canonical([[[120,80,12],[180,90,12]],[[120,520,12],[180,510,12]]]));
  });
  await test('Mode and canvas axes are stable during a gesture', async () => {
    const f=fixture({mode:'Vertical'});
    const layer=await f.stroke([[100,80],[120,100]],{afterStart(){f.config.TOOL.attributes.symmetry.value='Both';f.config.WIDTH=1000;f.config.HEIGHT=900;}});
    close(canonical(worldGroups(layer)),canonical([[[100,80,12],[120,100,12]],[[700,80,12],[680,100,12]]]));
  });
  await test('Legacy flat brush points retain their coordinates on normalization', async () => {
    const f=fixture();
    const flat=[[10,20,4],[30,40,4],null,[50,60,4]];
    const before=json(flat), grouped=f.brush.check_legacy_format(flat);
    assert.deepEqual(grouped,[[[10,20,4],[30,40,4]],[[50,60,4]]]);
    assert.deepEqual(flat,before);
  });
  await test('Edge and outside samples reflect without coordinate clamping', async () => {
    const f=fixture({mode:'Both'}), layer=await f.stroke([[0,0],[-8,12],[810,610]]);
    assert.equal(worldGroups(layer).length,4);
    const vertices=worldGroups(layer).flat();
    assert.ok(vertices.some(([x,y])=>x===-10&&y===-10));
    assert.ok(vertices.some(([x,y])=>x===808&&y===588));
  });
  await test('Axis-centered preview issues only one dot draw call', async () => {
    const f=fixture({mode:'Both'});
    f.brush.dragStart({...f.event(400,300),type:'mousedown'}); await f.flush();
    const calls=[];
    const ctx=new Proxy({}, {get(target,key){if (key in target) return target[key]; return (...args)=>calls.push([key,...args]);},set(target,key,value){target[key]=value;return true;}});
    f.brush.render(ctx,f.config.layer);
    assert.equal(calls.filter(call=>call[0]==='arc').length,1);
    assert.equal(calls.filter(call=>call[0]==='fill').length,1);
  });
  await test('Repeated intentional axis gestures are retained separately', async () => {
    const f=fixture({mode:'Both'});
    await f.stroke([[400,300]]); await f.stroke([[400,300]]);
    assert.equal(worldGroups(f.config.layer).length,2);
    assert.equal(f.app.State.action_history.length,2);
  });
  await test('Layer opacity and ordinary saved params survive appended symmetry', async () => {
    const f=fixture({mode:'Both'});
    await f.stroke([[80,60],[120,90]]);
    await f.app.State.do_action(new f.app.Actions.Update_layer_action(f.config.layer.id,{opacity:37})); await f.flush();
    await f.stroke([[160,120],[200,150]]);
    assert.equal(f.config.layer.opacity,37);
    assert.deepEqual(f.config.layer.params,{size:12,pressure:false});
    assert.equal(f.config.layers.length,1);
  });
  await test('Actual zoomView at 80 percent deduplicates a mathematical center dot', async () => {
    const f=fixture({mode:'Both',zoom:0.8});
    const view=f.load('src/js/libs/zoomView.js').default;
    view.setContext({canvas:{width:640,height:480},setTransform(){}});
    view.setBounds(0,0,800,600); view.scaleAt(0,0,0.8);
    f.layers.get_world_coords=(x,y)=>view.toWorld(x,y);
    const center=view.toWorld(320,240);
    assert.ok(Math.abs(center.x-400)<1e-8&&Math.abs(center.y-300)<1e-8);
    const layer=await f.stroke([[400,300]]);
    assert.equal(worldGroups(layer).length,1,`numeric center (${center.x},${center.y}) should not be painted four times`);
  });
  await test('A layer-parameter edit cannot change captured gesture sample widths', async () => {
    const f=fixture({mode:'Both'});
    const layer=await f.stroke([[100,80],[120,110]],{afterStart(){f.config.layer.params.size=72;}});
    for(const group of worldGroups(layer)) close(group.map(point=>point[2]),[12,12]);
  });
  await test('Moving a layer during a gesture preserves move plus stroke undo and redo', async () => {
    const f=fixture({mode:'Both'}), before=json(f.config.layers);
    f.brush.dragStart({...f.event(100,80),type:'mousedown'}); await f.flush();
    f.brush.dragMove({...f.event(120,110),type:'mousemove'}); await f.flush();
    await f.app.State.do_action(new f.app.Actions.Update_layer_action(f.config.layer.id,{x:45,y:70})); await f.flush();
    f.brush.dragEnd({...f.event(120,110),type:'mouseup'}); await f.flush();
    const after=json(f.config.layers);
    await f.app.State.undo_action(); await f.app.State.undo_action(); assert.deepEqual(json(f.config.layers),before);
    await f.app.State.redo_action(); await f.app.State.redo_action(); assert.deepEqual(json(f.config.layers),after);
  });
  await test('Selection change during a gesture cannot append to the new selection', async () => {
    const f=fixture({mode:'Both'});
    f.brush.dragStart({...f.event(100,80),type:'mousedown'}); await f.flush();
    const old=f.config.layer;
    const other={id:99,type:'brush',data:[[[0,0,12]]],params:{size:12,pressure:false},x:20,y:25,color:'#000000'};
    f.config.layers.push(other); f.config.layer=other; const otherBefore=json(other);
    f.brush.dragMove({...f.event(120,110),type:'mousemove'}); await f.flush();
    assert.deepEqual(other,otherBefore); assert.equal(old.status,null); assert.equal(f.brush.gesture,null);
    assert.ok(worldGroups(old).every(group=>group.length===1));
  });
  await test('Undo during a gesture cannot mutate the restored layer', async () => {
    const f=fixture({mode:'Both'}), before=json(f.config.layers);
    f.brush.dragStart({...f.event(100,80),type:'mousedown'}); await f.flush();
    await f.app.State.undo_action();
    f.brush.dragMove({...f.event(120,110),type:'mousemove'}); await f.flush();
    assert.deepEqual(json(f.config.layers),before); assert.equal(f.brush.gesture,null);
    await f.app.State.redo_action();
    assert.equal(worldGroups(f.config.layer).length,4);
    assert.ok(worldGroups(f.config.layer).every(group=>group.length===1));
  });
  await test('Appending to legacy flat data preserves old paths and restores old schema on undo', async () => {
    const f=fixture({mode:'Vertical'});
    Object.assign(f.config.layer,{type:'brush',data:[[10,20,12],[30,40,12],null,[50,60,12]],params:{size:12,pressure:false},x:100,y:20,width:50,height:60,color:'#1769e0',status:null});
    f.brush.params_hash=f.brush.get_params_hash();
    const before=json(f.config.layer);
    await f.stroke([[80,90],[100,140]]);
    close(worldGroups(f.config.layer).slice(0,2),[[[110,40,12],[130,60,12]],[[150,80,12]]]);
    await f.app.State.undo_action(); assert.deepEqual(json(f.config.layer),before);
  });
  await test('Appending to a hidden brush layer preserves baseline visibility semantics', async () => {
    const f=fixture({mode:'Vertical'});
    await f.stroke([[100,70],[120,100]]);
    await f.app.State.do_action(new f.app.Actions.Update_layer_action(f.config.layer.id,{visible:false})); await f.flush();
    const before=json(f.config.layer);
    await f.stroke([[180,200],[190,240]]);
    assert.equal(f.config.layer.visible,false); assert.equal(worldGroups(f.config.layer).length,4);
    await f.app.State.undo_action(); assert.deepEqual(json(f.config.layer),before);
  });
  await test('Two touch contacts keep separate paths in one atomic gesture', async () => {
    const f=fixture({mode:'Vertical'});
    const a=f.event(100,80,{identifier:11}), b=f.event(200,160,{identifier:22});
    f.brush.dragStart({type:'touchstart',changedTouches:[a,b]}); await f.flush();
    f.brush.dragMove({type:'touchmove',changedTouches:[f.event(120,100,{identifier:11}),f.event(230,180,{identifier:22})]}); await f.flush();
    f.brush.dragMove({type:'touchmove',changedTouches:[f.event(330,180,{identifier:999})]}); await f.flush();
    f.brush.dragEnd({type:'touchend',changedTouches:[a]}); await f.flush();
    assert.ok(f.brush.gesture);
    f.brush.dragEnd({type:'touchend',changedTouches:[b]}); await f.flush();
    assert.equal(f.brush.gesture,null); assert.equal(f.app.State.action_history.length,1);
    assert.equal(worldGroups(f.config.layer).length,4);
    assert.ok(worldGroups(f.config.layer).every(group=>group.length===2));
  });
  await test('Matching precise PointerEvent coordinates deduplicate a fractional-offset center dot', async () => {
    const f=fixture({mode:'Both',offset:{x:237.5,y:235}});
    const pointer=f.event(400,300,{type:'pointerdown',timeStamp:123.5,pointerType:'mouse',isPrimary:true,pressure:0.5});
    f.brush.pointerdown(pointer);
    const mouse={...pointer,type:'mousedown',pageX:Math.trunc(pointer.pageX),pageY:Math.trunc(pointer.pageY)};
    f.brush.dragStart(mouse); await f.flush();
    f.brush.dragEnd({...mouse,type:'mouseup'}); await f.flush();
    close(worldGroups(f.config.layer),[[[400,300,12]]]);
  });
  await test('Matching precise down and move events preserve subpixel symmetry trajectories', async () => {
    const f=fixture({mode:'Vertical',offset:{x:237.5,y:235}});
    const first=f.event(100.25,80.25,{type:'pointerdown',timeStamp:200,pointerType:'pen',isPrimary:true,pressure:0.5});
    f.brush.pointerdown(first);
    f.brush.dragStart({...first,type:'mousedown',pageX:Math.trunc(first.pageX),pageY:Math.trunc(first.pageY)}); await f.flush();
    const next=f.event(120.75,110.75,{type:'pointermove',timeStamp:201,pointerType:'pen',isPrimary:true,pressure:0.5});
    f.brush.pointermove(next);
    const mouse={...next,type:'mousemove',pageX:Math.trunc(next.pageX),pageY:Math.trunc(next.pageY)};
    f.brush.dragMove(mouse); await f.flush(); f.brush.dragEnd({...mouse,type:'mouseup'}); await f.flush();
    close(canonical(worldGroups(f.config.layer)),canonical([[[100.25,80.25,12],[120.75,110.75,12]],[[699.75,80.25,12],[679.25,110.75,12]]]));
  });
  await test('Off retains baseline MouseEvent coordinates despite a precise matching pointer', async () => {
    const f=fixture({mode:'Off',offset:{x:237.5,y:235}});
    const pointer=f.event(400,300,{type:'pointerdown',timeStamp:300,pointerType:'mouse',isPrimary:true,pressure:0.5});
    f.brush.pointerdown(pointer);
    const mouse={...pointer,type:'mousedown',pageX:Math.trunc(pointer.pageX),pageY:Math.trunc(pointer.pageY)};
    f.brush.dragStart(mouse); await f.flush(); f.brush.dragEnd({...mouse,type:'mouseup'}); await f.flush();
    close(worldGroups(f.config.layer),[[[399.5,300,12]]]);
  });
  for(const mismatch of ['timestamp','type','target','secondary','touch']) {
    await test(`Precise pointer fallback rejects ${mismatch} mismatch`, async () => {
      const f=fixture({mode:'Vertical',offset:{x:237.5,y:235}});
      const pointer=f.event(100.25,80.25,{type:'pointerdown',timeStamp:400,pointerType:'mouse',isPrimary:true,pressure:0.5});
      if(mismatch==='secondary') pointer.isPrimary=false;
      if(mismatch==='touch') pointer.pointerType='touch';
      if(mismatch==='type') f.brush.pointermove({...pointer,type:'pointermove'}); else f.brush.pointerdown(pointer);
      const mouse={...pointer,type:'mousedown',pageX:Math.trunc(pointer.pageX),pageY:Math.trunc(pointer.pageY)};
      if(mismatch==='timestamp') mouse.timeStamp=401;
      if(mismatch==='target') mouse.target={id:'canvas_minipaint'};
      f.brush.dragStart(mouse); await f.flush(); f.brush.dragEnd({...mouse,type:'mouseup'}); await f.flush();
      close(canonical(worldGroups(f.config.layer)),canonical([[[99.5,80,12]],[[700.5,80,12]]]));
    });
  }
  const summary={generatedAt:new Date().toISOString(),node:process.version,scope:'Actual Brush, Base_tools, State, Bundle/Insert/Update action logic; DOM/GUI/renderer are explicit doubles. No Canvas pixels, native hardware, browser persistence or export claims.',passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length,results};
  fs.writeFileSync(path.join(__dirname,'logic-results.json'),JSON.stringify(summary,null,2)+'\n');
  console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
  process.exitCode=summary.failed ? 1 : 0;
})().catch(error=>{console.error(error);process.exitCode=1;});
