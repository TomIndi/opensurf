// Entity lump parser tests (synthetic text; the real-map checks live in bsp_maps.test.ts).
import { describe, expect, it } from 'vitest';
import { parseEntities, parseOutputValue, serializeEntities } from '../src/bsp/entities';

describe('entities: tokenizer', () => {
  it('parses basic blocks, lower-cases keys, last key wins', () => {
    const ents = parseEntities(`{
"classname" "worldspawn"
"SkyName" "sky_dust"
"skyname" "sky_final"
}
{
"classname" "info_player_counterterrorist"
"origin" "-128 256.5 64"
"angles" "0 90 0"
}`);
    expect(ents.length).toBe(2);
    expect(ents[0].index).toBe(0);
    expect(ents[0].classname).toBe('worldspawn');
    expect(ents[0].kv.skyname).toBe('sky_final');
    expect(ents[1].index).toBe(1);
    expect(ents[1].origin).toEqual({ x: -128, y: 256.5, z: 64 });
    expect(ents[1].angles).toEqual({ pitch: 0, yaw: 90, roll: 0 });
    expect(ents[1].model).toBe(-1);
    expect(ents[1].targetname).toBe('');
  });

  it('keeps braces, newlines and odd characters inside quotes', () => {
    const ents = parseEntities(
      '{"classname" "game_text" "message" "line1\nline2 {not a brace} \\\\ ;:\'()" "targetname" "txt"}' + '\r\n{ "classname"\t"info_target" }',
    );
    expect(ents.length).toBe(2);
    expect(ents[0].kv.message).toBe("line1\nline2 {not a brace} \\\\ ;:'()");
    expect(ents[0].targetname).toBe('txt');
    expect(ents[1].classname).toBe('info_target');
  });

  it('accepts unquoted tokens, comments and junk between entities', () => {
    const ents = parseEntities(`// header comment
junk { classname info_target
targetname "dest_1" // trailing comment
origin "1 2 3" }
garbage
{ "classname" "light" }`);
    expect(ents.length).toBe(2);
    expect(ents[0].classname).toBe('info_target');
    expect(ents[0].targetname).toBe('dest_1');
    expect(ents[0].origin).toEqual({ x: 1, y: 2, z: 3 });
    expect(ents[1].classname).toBe('light');
  });

  it('recovers from a missing closing brace and a key without value', () => {
    const ents = parseEntities('{ "classname" "a" "lonely" }\n{ "classname" "b"\n{ "classname" "c" }');
    expect(ents.map((e) => e.classname)).toEqual(['a', 'b', 'c']);
    expect(ents[0].kv.lonely).toBeUndefined();
  });

  it('tolerates an unterminated quote at the end and trailing NULs', () => {
    const ents = parseEntities('{ "classname" "x" }\n{ "classname" "y" "message" "oops\0\0');
    expect(ents.map((e) => e.classname)).toEqual(['x', 'y']);
    expect(parseEntities('')).toEqual([]);
    expect(parseEntities('\0\0\0')).toEqual([]);
  });

  it('ignores a __proto__ key', () => {
    const ents = parseEntities('{ "classname" "x" "__proto__" "bad" }');
    expect(Object.getPrototypeOf(ents[0].kv)).toBe(Object.prototype);
    expect(ents[0].kv.classname).toBe('x');
  });
});

describe('entities: I/O connections', () => {
  it('parses comma-separated outputs and keeps them out of kv', () => {
    const [e] = parseEntities(`{
"classname" "trigger_multiple"
"OnStartTouch" "!activator,AddOutput,basevelocity 0 0 800,0,-1"
"OnEndTouch" "relay_1,Trigger,,0.5,1"
"OnTrigger" "door,Open,,0,0"
"wait" "1"
}`);
    expect(e.kv.onstarttouch).toBeUndefined();
    expect(e.kv.wait).toBe('1');
    expect(e.outputs).toEqual([
      { event: 'onstarttouch', target: '!activator', input: 'AddOutput', param: 'basevelocity 0 0 800', delay: 0, timesToFire: -1 },
      { event: 'onendtouch', target: 'relay_1', input: 'Trigger', param: '', delay: 0.5, timesToFire: 1 },
      // times "0" means unlimited, like the engine
      { event: 'ontrigger', target: 'door', input: 'Open', param: '', delay: 0, timesToFire: -1 },
    ]);
  });

  it('parses CS:GO ESC (0x1B) separated outputs, where params may contain commas', () => {
    const [e] = parseEntities('{ "classname" "logic_relay" "OnTrigger" "tp\x1bAddOutput\x1borigin 1,2,3\x1b2.25\x1b3" }');
    expect(e.outputs).toEqual([{ event: 'ontrigger', target: 'tp', input: 'AddOutput', param: 'origin 1,2,3', delay: 2.25, timesToFire: 3 }]);
  });

  it('recognises outputs without the "On" prefix and keeps repeated outputs in order', () => {
    const [e] = parseEntities(`{ "classname" "game_ui"
"PressedForward" "a,Trigger,,0,-1"
"PressedForward" "b,Trigger,,0,-1"
"OutValue" "c,SetValue,,0,-1" }`);
    expect(e.outputs.map((o) => `${o.event}:${o.target}`)).toEqual(['pressedforward:a', 'pressedforward:b', 'outvalue:c']);
  });

  it('keeps "on*" keys that are not connections as keyvalues', () => {
    const [e] = parseEntities('{ "classname" "x" "onlyonce" "1" "OnUser1" "not,an output" }');
    expect(e.outputs).toEqual([]);
    expect(e.kv.onlyonce).toBe('1');
    expect(e.kv.onuser1).toBe('not,an output');
  });

  it('parseOutputValue handles missing fields', () => {
    expect(parseOutputValue('OnTrigger', 't,i,p,1')).toEqual({ event: 'ontrigger', target: 't', input: 'i', param: 'p', delay: 1, timesToFire: -1 });
    expect(parseOutputValue('OnTrigger', 't,i,p,x,y')?.delay).toBe(0);
    expect(parseOutputValue('OnTrigger', 'no commas')).toBeNull();
  });
});

describe('entities: origin / angles / model', () => {
  const one = (body: string) => parseEntities(`{ ${body} }`)[0];

  it('uses "angle" as yaw with the up/down specials', () => {
    expect(one('"classname" "info_teleport_destination" "angle" "270"').angles).toEqual({ pitch: 0, yaw: 270, roll: 0 });
    expect(one('"classname" "func_door" "angle" "-1"').angles).toEqual({ pitch: -90, yaw: 0, roll: 0 });
    expect(one('"classname" "func_door" "angle" "-2"').angles).toEqual({ pitch: 90, yaw: 0, roll: 0 });
    // "angles" wins over "angle"
    expect(one('"classname" "x" "angle" "45" "angles" "10 20 30"').angles).toEqual({ pitch: 10, yaw: 20, roll: 30 });
    expect(one('"classname" "x"').angles).toEqual({ pitch: 0, yaw: 0, roll: 0 });
  });

  it('lets lights override the pitch with "pitch"', () => {
    expect(one('"classname" "light_environment" "angles" "0 45 0" "pitch" "-60"').angles).toEqual({ pitch: -60, yaw: 45, roll: 0 });
    expect(one('"classname" "light_spot" "pitch" "-90"').angles.pitch).toBe(-90);
    expect(one('"classname" "info_target" "angles" "0 45 0" "pitch" "-60"').angles.pitch).toBe(0);
  });

  it('parses brush model references and tolerates bad numbers', () => {
    expect(one('"classname" "trigger_push" "model" "*12"').model).toBe(12);
    expect(one('"classname" "prop_static" "model" "models/props/x.mdl"').model).toBe(-1);
    expect(one('"classname" "x" "model" "*"').model).toBe(-1);
    expect(one('"classname" "x" "origin" "1 nan"').origin).toEqual({ x: 1, y: 0, z: 0 });
  });

  it('round-trips through serializeEntities', () => {
    const text = '{ "classname" "trigger_teleport" "target" "d1" "OnStartTouch" "!self,Kill,,0,-1" }';
    const a = parseEntities(text);
    const b = parseEntities(serializeEntities(a));
    expect(b).toEqual(a);
  });
});
