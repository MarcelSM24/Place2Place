/**
 * Routing smoke tests validating H3 conversion and route computation between city points.
 */
import test from 'brittle';
import h3 from 'h3-js';
import { calculateRoute, getHexFromLatLng } from './routing.js';

test('getHexFromLatLng returns valid H3 cell', (t) => {
  const hex = getHexFromLatLng(41.387, 2.17);
  t.is(typeof hex, 'string', 'returns a hex string');
  t.ok(h3.isValidCell(hex), 'returns a valid H3 cell');
});

test('calculateRoute returns a usable route between Barcelona points', (t) => {
  const startHex = getHexFromLatLng(41.387, 2.17);
  const endHex = getHexFromLatLng(41.395, 2.19);
  const route = calculateRoute(startHex, endHex);

  t.ok(Array.isArray(route), 'route is an array');
  t.ok(route.length >= 1, 'route has at least one node');
  t.ok(h3.isValidCell(route[0]), 'first route entry is a valid H3 cell');
  t.ok(h3.isValidCell(route[route.length - 1]), 'last route entry is a valid H3 cell');
});
