'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

import type {Lines, Print} from '../../types/common';
import type {VariableDeclarator} from 'ast-types-flow';

var flatten = require('../../utils/flatten');
var markers = require('../../constants/markers');

function printVariableDeclarator(
  print: Print,
  node: VariableDeclarator,
): Lines {
  if (node.init) {
    let init = node.init;
    return flatten([
      print(node.id),
      markers.space,
      '=',
      markers.space,
      print(init),
    ]);
  } else {
    return flatten(print(node.id));
  }
}

module.exports = printVariableDeclarator;
