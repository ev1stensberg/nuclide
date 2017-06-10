/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 *
 * @flow
 * @format
 */

/* global performance */

import type {
  AnyDatatipProvider,
  Datatip,
  DatatipProvider,
  ModifierDatatipProvider,
  ModifierKey,
} from './types';

import Immutable from 'immutable';
import React from 'react';
import ReactDOM from 'react-dom';
import UniversalDisposable from 'nuclide-commons/UniversalDisposable';
import analytics from 'nuclide-commons-atom/analytics';
import debounce from 'nuclide-commons/debounce';
import featureConfig from 'nuclide-commons-atom/feature-config';
import idx from 'idx';
import performanceNow from 'nuclide-commons/performanceNow';
import {Observable} from 'rxjs';
import {arrayCompact, arrayRemove} from 'nuclide-commons/collection';
import {asyncFind} from 'nuclide-commons/promise';
import {getLogger} from 'log4js';
import {observeTextEditors} from 'nuclide-commons-atom/text-editor';
import {
  getModifierKeysFromMouseEvent,
  getModifierKeyFromKeyboardEvent,
} from './getModifierKeys';

import {DatatipComponent, DATATIP_ACTIONS} from './DatatipComponent';
import {PinnedDatatip} from './PinnedDatatip';

const logger = getLogger('nuclide-datatip');

const CUMULATIVE_WHEELX_THRESHOLD = 20;
const DEFAULT_DATATIP_DEBOUNCE_DELAY = 1000;
const DEFAULT_DATATIP_INTERACTED_DEBOUNCE_DELAY = 1000;

type PinClickHandler = (editor: atom$TextEditor, datatip: Datatip) => void;

function getProviderName(provider: AnyDatatipProvider): string {
  if (provider.providerName == null) {
    logger.error('Datatip provider has no name', provider);
    return 'unknown';
  }
  return provider.providerName;
}

function filterProvidersByScopeName<T: AnyDatatipProvider>(
  providers: Array<T>,
  scopeName: string,
): Array<T> {
  return providers
    .filter(
      provider =>
        provider.inclusionPriority > 0 && provider.validForScope(scopeName),
    )
    .sort(
      (providerA, providerB) =>
        providerB.inclusionPriority - providerA.inclusionPriority,
    );
}

function getBufferPosition(
  editor: TextEditor,
  editorView: atom$TextEditorElement,
  event: ?MouseEvent,
): null | atom$Point {
  if (!event) {
    return null;
  }

  const text = editorView.component;
  if (!text) {
    return null;
  }

  const screenPosition = text.screenPositionForMouseEvent(event);
  const pixelPosition = text.pixelPositionForMouseEvent(event);
  const pixelPositionFromScreenPosition = text.pixelPositionForScreenPosition(
    screenPosition,
  );
  // Distance (in pixels) between screenPosition and the cursor.
  const horizontalDistance =
    pixelPosition.left - pixelPositionFromScreenPosition.left;
  // `screenPositionForMouseEvent.column` cannot exceed the current line length.
  // This is essentially a heuristic for "mouse cursor is to the left or right
  // of text content".
  if (
    pixelPosition.left < 0 ||
    horizontalDistance > editor.getDefaultCharWidth()
  ) {
    return null;
  }
  return editor.bufferPositionForScreenPosition(screenPosition);
}

async function getTopDatatipAndProvider<T1: AnyDatatipProvider>(
  providers: Array<T1>,
  editor: atom$TextEditor,
  position: atom$Point,
  invoke: T1 => Promise<?Datatip>,
): Promise<?{provider: T1, datatip: Datatip}> {
  const {scopeName} = editor.getGrammar();
  const filteredDatatipProviders = filterProvidersByScopeName(
    providers,
    scopeName,
  );
  if (filteredDatatipProviders.length === 0) {
    return null;
  }

  const datatipPromises = providers.map(async (provider: T1): Promise<?{
    provider: T1,
    datatip: Datatip,
  }> => {
    const name = getProviderName(provider);
    const timingTracker = new analytics.TimingTracker(name + '.datatip');
    try {
      const datatip = await invoke(provider);
      if (!datatip) {
        return null;
      }

      timingTracker.onSuccess();

      return {
        datatip,
        provider,
      };
    } catch (e) {
      timingTracker.onError(e);
      logger.error(`Error getting datatip from provider ${name}`, e);
      return null;
    }
  });

  return asyncFind(datatipPromises, p => p);
}

type PinnableDatatipProps = {
  datatip: Datatip,
  editor: atom$TextEditor,
  onPinClick: PinClickHandler,
};

function PinnableDatatip({
  datatip,
  editor,
  onPinClick,
}: PinnableDatatipProps): React.Element<any> {
  let action;
  let actionTitle;
  // Datatips are pinnable by default, unless explicitly specified
  // otherwise.
  if (datatip.pinnable !== false) {
    action = DATATIP_ACTIONS.PIN;
    actionTitle = 'Pin this Datatip';
  }

  return (
    <DatatipComponent
      action={action}
      actionTitle={actionTitle}
      datatip={datatip}
      onActionClick={() => onPinClick(editor, datatip)}
    />
  );
}

function mountDatatipWithMarker(
  editor,
  element,
  {
    range,
    renderedProviders,
  }: {
    range: atom$Range,
    renderedProviders: React.Element<any>,
  },
): atom$Marker {
  // Transform the matched element range to the hint range.
  const marker: atom$Marker = editor.markBufferRange(range, {
    invalidate: 'never',
  });

  ReactDOM.render(renderedProviders, element);
  element.style.display = 'block';

  editor.decorateMarker(marker, {
    type: 'overlay',
    position: 'tail',
    item: element,
  });

  editor.decorateMarker(marker, {
    type: 'highlight',
    class: 'nuclide-datatip-highlight-region',
  });

  return marker;
}

const DatatipState = Object.freeze({
  HIDDEN: 'HIDDEN',
  FETCHING: 'FETCHING',
  VISIBLE: 'VISIBLE',
});
type State = $Keys<typeof DatatipState>;

function ensurePositiveNumber(value: any, defaultValue: number): number {
  if (typeof value !== 'number' || value < 0) {
    return defaultValue;
  }
  return value;
}

class DatatipManagerForEditor {
  _blacklistedPosition: ?atom$Point;
  _datatipElement: HTMLElement;
  _datatipProviders: Array<DatatipProvider>;
  _modifierDatatipProviders: Array<ModifierDatatipProvider>;
  _datatipState: State;
  _editor: atom$TextEditor;
  _editorView: atom$TextEditorElement;
  _insideDatatip: boolean;
  _lastHiddenTime: number;
  _lastFetchedFromCursorPosition: boolean;
  _lastMoveEvent: ?MouseEvent;
  _lastPosition: ?atom$Point;
  _lastDatatipAndProviderPromise: ?Promise<?{
    datatip: Datatip,
    provider: DatatipProvider,
  }>;
  _heldKeys: Immutable.Set<ModifierKey>;
  _marker: ?atom$Marker;
  _pinnedDatatips: Set<PinnedDatatip>;
  _range: ?atom$Range;
  _shouldDropNextMouseMoveAfterFocus: boolean;
  _startFetchingDebounce: () => void;
  _hideIfOutsideDebounce: () => void;
  _subscriptions: UniversalDisposable;
  _interactedWith: boolean;
  _cumulativeWheelX: number;

  constructor(
    editor: atom$TextEditor,
    datatipProviders: Array<DatatipProvider>,
    modifierDatatipProviders: Array<ModifierDatatipProvider>,
  ) {
    this._editor = editor;
    this._editorView = atom.views.getView(editor);
    this._pinnedDatatips = new Set();
    this._subscriptions = new UniversalDisposable();
    this._datatipProviders = datatipProviders;
    this._modifierDatatipProviders = modifierDatatipProviders;
    this._datatipElement = document.createElement('div');
    this._datatipElement.className = 'nuclide-datatip-overlay';
    this._datatipState = DatatipState.HIDDEN;
    this._heldKeys = new Immutable.Set();
    this._interactedWith = false;
    this._cumulativeWheelX = 0;
    this._lastHiddenTime = 0;
    this._lastFetchedFromCursorPosition = false;
    this._shouldDropNextMouseMoveAfterFocus = false;

    this._subscriptions.add(
      featureConfig.observe('nuclide-datatip.datatipDebounceDelay', () =>
        this._setStartFetchingDebounce(),
      ),
      featureConfig.observe(
        'nuclide-datatip.datatipInteractedWithDebounceDelay',
        () => this._setHideIfOutsideDebounce(),
      ),
      Observable.fromEvent(this._editorView, 'focus').subscribe(e => {
        this._shouldDropNextMouseMoveAfterFocus = true;
        if (!this._insideDatatip) {
          this._setState(DatatipState.HIDDEN);
        }
      }),
      Observable.fromEvent(this._editorView, 'blur').subscribe(e => {
        if (!this._insideDatatip) {
          this._setState(DatatipState.HIDDEN);
        }
      }),
      Observable.fromEvent(this._editorView, 'mousemove').subscribe(e => {
        this._lastFetchedFromCursorPosition = false;
        if (this._shouldDropNextMouseMoveAfterFocus) {
          this._shouldDropNextMouseMoveAfterFocus = false;
          return;
        }

        this._lastMoveEvent = e;
        this._heldKeys = getModifierKeysFromMouseEvent(e);
        if (this._datatipState === DatatipState.HIDDEN) {
          this._startFetchingDebounce();
        } else {
          this._hideIfOutside();
        }
      }),
      Observable.fromEvent(this._editorView, 'mouseleave').subscribe(() => {
        this._lastMoveEvent = null;
        this._hideIfOutside();
      }),
      Observable.fromEvent(this._editorView, 'mousedown').subscribe(e => {
        let node = e.target;
        while (node !== null) {
          if (node === this._datatipElement) {
            return;
          }
          node = node.parentNode;
        }

        this._hideOrCancel();
      }),
      Observable.fromEvent(this._editorView, 'keydown').subscribe(e => {
        const modifierKey = getModifierKeyFromKeyboardEvent(e);
        if (modifierKey) {
          this._heldKeys = this._heldKeys.add(modifierKey);
          if (this._datatipState !== DatatipState.HIDDEN) {
            this._fetchInResponseToKeyPress();
          }
        } else {
          this._hideOrCancel();
        }
      }),
      Observable.fromEvent(this._editorView, 'keyup').subscribe(e => {
        const modifierKey = getModifierKeyFromKeyboardEvent(e);
        if (modifierKey) {
          this._heldKeys = this._heldKeys.delete(modifierKey);
          if (this._datatipState !== DatatipState.HIDDEN) {
            this._fetchInResponseToKeyPress();
          }
        }
      }),
      Observable.fromEvent(this._datatipElement, 'wheel').subscribe(e => {
        this._cumulativeWheelX += Math.abs(e.deltaX);
        if (this._cumulativeWheelX > CUMULATIVE_WHEELX_THRESHOLD) {
          this._interactedWith = true;
        }
        if (this._interactedWith) {
          e.stopPropagation();
        }
      }),
      Observable.fromEvent(this._datatipElement, 'mousedown').subscribe(() => {
        this._interactedWith = true;
      }),
      Observable.fromEvent(this._datatipElement, 'mouseenter').subscribe(() => {
        this._insideDatatip = true;
        this._hideIfOutside();
      }),
      Observable.fromEvent(this._datatipElement, 'mouseleave').subscribe(() => {
        this._insideDatatip = false;
        this._hideIfOutside();
      }),
      this._editorView.onDidChangeScrollTop(() => {
        this._lastMoveEvent = null;
        if (this._datatipState === DatatipState.VISIBLE) {
          this._setState(DatatipState.HIDDEN);
        }
      }),
      atom.commands.add(
        'atom-text-editor',
        'nuclide-datatip:toggle',
        this._toggleDatatip,
      ),
    );
  }

  _fetchInResponseToKeyPress() {
    if (this._lastFetchedFromCursorPosition) {
      this._startFetching(() => this._editor.getCursorBufferPosition());
    } else {
      this._startFetching(() =>
        getBufferPosition(this._editor, this._editorView, this._lastMoveEvent),
      );
    }
  }

  _setStartFetchingDebounce(): void {
    this._startFetchingDebounce = debounce(
      () => {
        this._startFetching(() =>
          getBufferPosition(
            this._editor,
            this._editorView,
            this._lastMoveEvent,
          ),
        );
      },
      ensurePositiveNumber(
        (featureConfig.get('nuclide-datatip.datatipDebounceDelay'): any),
        DEFAULT_DATATIP_DEBOUNCE_DELAY,
      ),
      /* immediate */ false,
    );
  }

  _setHideIfOutsideDebounce(): void {
    this._hideIfOutsideDebounce = debounce(
      () => {
        this._hideIfOutsideImmediate();
      },
      ensurePositiveNumber(
        (featureConfig.get(
          'nuclide-datatip.datatipInteractedWithDebounceDelay',
        ): any),
        DEFAULT_DATATIP_INTERACTED_DEBOUNCE_DELAY,
      ),
      /* immediate */ false,
    );
  }

  dispose(): void {
    this._setState(DatatipState.HIDDEN);
    this._subscriptions.dispose();
    this._datatipElement.remove();
  }

  _setState(newState: State): void {
    const oldState = this._datatipState;
    this._datatipState = newState;

    if (newState === DatatipState.HIDDEN) {
      this._blacklistedPosition = null;
      if (oldState !== DatatipState.HIDDEN) {
        this._hideDatatip();
      }
    }
  }

  async _startFetching(getPosition: () => ?atom$Point): Promise<void> {
    const position = getPosition();
    if (!position) {
      return;
    }

    this._setState(DatatipState.FETCHING);

    const data = await this._fetchAndRender(position);
    if (data == null) {
      this._setState(DatatipState.HIDDEN);
      return;
    }
    if (this._datatipState !== DatatipState.FETCHING) {
      this._setState(DatatipState.HIDDEN);
    }

    if (
      this._blacklistedPosition &&
      data.range &&
      data.range.containsPoint(this._blacklistedPosition)
    ) {
      this._setState(DatatipState.HIDDEN);
      return;
    }

    const currentPosition = getPosition();
    if (
      !currentPosition ||
      !data.range ||
      !data.range.containsPoint(currentPosition)
    ) {
      this._setState(DatatipState.HIDDEN);
      return;
    }

    if (this._isHoveringOverPinnedTip()) {
      this._setState(DatatipState.HIDDEN);
      return;
    }

    this._setState(DatatipState.VISIBLE);
    this._interactedWith = false;
    this._cumulativeWheelX = 0;
    this._range = data.range;

    if (this._marker) {
      this._marker.destroy();
    }
    this._marker = mountDatatipWithMarker(
      this._editor,
      this._datatipElement,
      data,
    );
  }

  async _fetchAndRender(
    position: atom$Point,
  ): Promise<?{
    range: atom$Range,
    renderedProviders: React$Element<*>,
  }> {
    let datatipAndProviderPromise;
    if (this._lastPosition && position.isEqual(this._lastPosition)) {
      datatipAndProviderPromise = this._lastDatatipAndProviderPromise;
    } else {
      this._lastDatatipAndProviderPromise = getTopDatatipAndProvider(
        this._datatipProviders,
        this._editor,
        position,
        provider => provider.datatip(this._editor, position),
      );
      datatipAndProviderPromise = this._lastDatatipAndProviderPromise;
      this._lastPosition = position;
    }

    const datatipsAndProviders = arrayCompact(
      await Promise.all([
        datatipAndProviderPromise,
        getTopDatatipAndProvider(
          this._modifierDatatipProviders,
          this._editor,
          position,
          provider =>
            provider.modifierDatatip(this._editor, position, this._heldKeys),
        ),
      ]),
    );

    if (datatipsAndProviders.length === 0) {
      return null;
    }

    const range = datatipsAndProviders[0].datatip.range;
    analytics.track('datatip-popup', {
      scope: this._editor.getGrammar().scopeName,
      providerName: getProviderName(datatipsAndProviders[0].provider),
      rangeStartRow: String(range.start.row),
      rangeStartColumn: String(range.start.column),
      rangeEndRow: String(range.end.row),
      rangeEndColumn: String(range.end.column),
    });

    const renderedProviders = (
      <div>
        {datatipsAndProviders.map(({datatip, provider}) => (
          <PinnableDatatip
            datatip={datatip}
            editor={this._editor}
            key={getProviderName(provider)}
            onPinClick={this._handlePinClicked}
          />
        ))}
      </div>
    );

    return {
      range,
      renderedProviders,
    };
  }

  _isHoveringOverPinnedTip(): boolean {
    const pinnedDataTips = Array.from(this._pinnedDatatips.values());
    const hoveringTips = pinnedDataTips.filter(dt => dt.isHovering());
    return hoveringTips != null && hoveringTips.length > 0;
  }

  _hideDatatip(): void {
    this._lastHiddenTime = performance.now();
    if (this._marker) {
      this._marker.destroy();
      this._marker = null;
    }
    this._range = null;
    ReactDOM.unmountComponentAtNode(this._datatipElement);
    this._datatipElement.style.display = 'none';
  }

  _hideOrCancel(): void {
    if (
      this._datatipState === DatatipState.HIDDEN ||
      this._datatipState === DatatipState.FETCHING
    ) {
      this._blacklistedPosition = getBufferPosition(
        this._editor,
        this._editorView,
        this._lastMoveEvent,
      );
      return;
    }

    this._setState(DatatipState.HIDDEN);
  }

  _hideIfOutside(): void {
    if (this._datatipState !== DatatipState.VISIBLE) {
      return;
    }

    if (this._interactedWith) {
      this._hideIfOutsideDebounce();
    } else {
      this._hideIfOutsideImmediate();
    }
  }

  _hideIfOutsideImmediate(): void {
    if (this._datatipState !== DatatipState.VISIBLE) {
      return;
    }
    if (this._insideDatatip) {
      return;
    }

    if (this._isHoveringOverPinnedTip()) {
      this._setState(DatatipState.HIDDEN);
      return;
    }

    const currentPosition = getBufferPosition(
      this._editor,
      this._editorView,
      this._lastMoveEvent,
    );
    if (
      currentPosition &&
      this._range &&
      this._range.containsPoint(currentPosition)
    ) {
      return;
    }

    this._setState(DatatipState.HIDDEN);
  }

  createPinnedDataTip(datatip: Datatip, editor: TextEditor): PinnedDatatip {
    const pinnedDatatip = new PinnedDatatip(
      datatip,
      editor,
      /* onDispose */ () => {
        this._pinnedDatatips.delete(pinnedDatatip);
      },
      /* hideDataTips */ () => {
        this._hideDatatip();
      },
    );
    return pinnedDatatip;
  }

  _handlePinClicked = (editor: TextEditor, datatip: Datatip) => {
    analytics.track('datatip-pinned-open');
    const startTime = performanceNow();
    this._setState(DatatipState.HIDDEN);
    this._pinnedDatatips.add(
      new PinnedDatatip(
        datatip,
        editor,
        /* onDispose */ pinnedDatatip => {
          this._pinnedDatatips.delete(pinnedDatatip);
          analytics.track('datatip-pinned-close', {
            duration: performanceNow() - startTime,
          });
        },
        /* hideDataTips */ () => {
          this._hideDatatip();
        },
      ),
    );
  };

  _toggleDatatip = (e?: atom$CustomEvent) => {
    if (atom.workspace.getActiveTextEditor() !== this._editor) {
      return;
    }

    // Note that we don't need to hide the tooltip, we already hide it on
    // keydown, which is going to be triggered before the key binding which is
    // evaluated on keyup.
    const maybeEventType = idx(e, _ => _.originalEvent.type);

    // Unfortunately, when you do keydown of the shortcut, it's going to
    // hide it, we need to make sure that when we do keyup, it doesn't show
    // it up right away. We assume that a keypress is done within 100ms
    // and don't show it again if it was hidden so soon.
    const forceShow =
      maybeEventType === 'keydown' &&
      performance.now() - this._lastHiddenTime > 100;
    const forceHide = maybeEventType === 'keyup';
    const forceToggle =
      maybeEventType !== 'keydown' && maybeEventType !== 'keyup';

    if (
      // if we have event information, prefer that for determining show/hide
      forceShow ||
      (forceToggle && this._datatipState === DatatipState.HIDDEN)
    ) {
      this._lastFetchedFromCursorPosition = true;
      this._startFetching(() => this._editor.getCursorScreenPosition());
    } else if (forceHide || forceToggle) {
      this._hideOrCancel();
    }
  };
}

export class DatatipManager {
  _datatipProviders: Array<DatatipProvider>;
  _modifierDatatipProviders: Array<ModifierDatatipProvider>;
  _editorManagers: Map<atom$TextEditor, DatatipManagerForEditor>;
  _subscriptions: UniversalDisposable;

  constructor() {
    this._subscriptions = new UniversalDisposable();
    this._editorManagers = new Map();
    this._datatipProviders = [];
    this._modifierDatatipProviders = [];

    this._subscriptions.add(
      observeTextEditors(editor => {
        const manager = new DatatipManagerForEditor(
          editor,
          this._datatipProviders,
          this._modifierDatatipProviders,
        );
        this._editorManagers.set(editor, manager);
        const dispose = () => {
          manager.dispose();
          this._editorManagers.delete(editor);
        };
        this._subscriptions.add(new UniversalDisposable(dispose));
        editor.onDidDestroy(dispose);
      }),
    );
  }

  addProvider(provider: DatatipProvider): IDisposable {
    this._datatipProviders.push(provider);
    return new UniversalDisposable(() => {
      arrayRemove(this._datatipProviders, provider);
    });
  }

  addModifierProvider(provider: ModifierDatatipProvider): IDisposable {
    this._modifierDatatipProviders.push(provider);
    return new UniversalDisposable(() => {
      arrayRemove(this._modifierDatatipProviders, provider);
    });
  }

  createPinnedDataTip(datatip: Datatip, editor: TextEditor): PinnedDatatip {
    const manager = this._editorManagers.get(editor);
    if (!manager) {
      throw new Error(
        'Trying to create a pinned data tip on an editor that has ' +
          'no datatip manager',
      );
    }
    return manager.createPinnedDataTip(datatip, editor);
  }

  dispose(): void {
    this._subscriptions.dispose();
    this._editorManagers.forEach(manager => {
      manager.dispose();
    });
    this._editorManagers = new Map();
  }
}
