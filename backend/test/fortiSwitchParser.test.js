import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePortSummary,
  parsePoeStatus,
  parseVlanTable,
  parseMacTable,
  parseAllowedVlansFromConfig,
} from '../src/ssh/fortiSwitchParser.js';

test('parsePortSummary', () => {
  const text = [
    'Port      Admin    Oper    Speed/Duplex  Native-Vlan  Description',
    'port1     up       up      1000full      10           DESK-ANNA',
    'port2     up       down    auto          10           -',
  ].join('\n');
  const rows = parsePortSummary(text);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    portName: 'port1',
    adminStatus: 'up',
    operStatus: 'up',
    speed: '1000full',
    nativeVlan: 10,
    description: 'DESK-ANNA',
  });
  assert.equal(rows[1].description, '');
});

test('parsePoeStatus', () => {
  const text = ['Port      PoE-Status  Power(W)  Class', 'port1     enabled     5.7       class2'].join('\n');
  const rows = parsePoeStatus(text);
  assert.deepEqual(rows, [{ portName: 'port1', poeEnabled: true, poeWatts: 5.7, poeClass: 'class2' }]);
});

test('parseVlanTable', () => {
  const text = ['VLAN-ID  Name', '1        default', '10       corp-users'].join('\n');
  assert.deepEqual(parseVlanTable(text), [
    { id: 1, name: 'default' },
    { id: 10, name: 'corp-users' },
  ]);
});

test('parseMacTable', () => {
  const text = ['Port      MAC-Address        VLAN  Type', 'port1     00:1c:2e:54:b1:7c  10    dynamic'].join('\n');
  assert.deepEqual(parseMacTable(text), [
    { portName: 'port1', macAddress: '00:1c:2e:54:b1:7c', vlan: 10, type: 'dynamic' },
  ]);
});

test('parseAllowedVlansFromConfig', () => {
  const config = [
    'config switch interface',
    '    edit "port23"',
    '        set native-vlan 99',
    '        set allowed-vlans 1,10,20,30,99',
    '    next',
    '    edit "port1"',
    '        set native-vlan 10',
    '    next',
    'end',
  ].join('\n');
  const result = parseAllowedVlansFromConfig(config);
  assert.deepEqual(result.port23, [1, 10, 20, 30, 99]);
  assert.deepEqual(result.port1, []);
});
