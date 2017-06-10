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

// TODO(hansonw): This needs to be moved.
// eslint-disable-next-line nuclide-internal/modules-dependencies
import type {
  Datatip,
  DatatipProvider,
  DatatipService,
} from '../../../../../pkg/nuclide-datatip/lib/types';
import type {DiagnosticMessage} from '../../atom-ide-diagnostics';
import type {
  FileMessageUpdate,
  ObservableDiagnosticUpdater,
} from '../../atom-ide-diagnostics';
import type {
  FileDiagnosticMessage,
  Trace,
} from '../../atom-ide-diagnostics/lib/rpc-types';
import type {
  WorkspaceViewsService,
} from 'nuclide-commons-atom/workspace-views-compat';

import invariant from 'assert';

import analytics from 'nuclide-commons-atom/analytics';

import createPackage from 'nuclide-commons-atom/createPackage';
import {observeTextEditors} from 'nuclide-commons-atom/text-editor';
import UniversalDisposable from 'nuclide-commons/UniversalDisposable';
import {observableFromSubscribeFunction} from 'nuclide-commons/event';
import {DiagnosticsViewModel, WORKSPACE_VIEW_URI} from './DiagnosticsViewModel';
import StatusBarTile from './StatusBarTile';
import {applyUpdateToEditor} from './gutter';
import {makeDiagnosticsDatatipComponent} from './DiagnosticsDatatipComponent';
import {goToLocation} from 'nuclide-commons-atom/go-to-location';
import featureConfig from 'nuclide-commons-atom/feature-config';
import {
  consumeWorkspaceViewsCompat,
} from 'nuclide-commons-atom/workspace-views-compat';
import {BehaviorSubject, Observable} from 'rxjs';

const LINTER_PACKAGE = 'linter';
const MAX_OPEN_ALL_FILES = 20;

type ActivationState = {
  filterByActiveTextEditor: boolean,
};

function disableLinter() {
  atom.packages.disablePackage(LINTER_PACKAGE);
}

class Activation {
  _diagnosticUpdaters: BehaviorSubject<?ObservableDiagnosticUpdater>;
  _subscriptions: UniversalDisposable;
  _state: ActivationState;
  _statusBarTile: ?StatusBarTile;
  _fileDiagnostics: WeakMap<atom$TextEditor, Array<FileDiagnosticMessage>>;

  constructor(state_: ?Object): void {
    this._diagnosticUpdaters = new BehaviorSubject(null);
    this._subscriptions = new UniversalDisposable();
    this._subscriptions.add(
      consumeWorkspaceViewsCompat(this.consumeWorkspaceViewsService.bind(this)),
    );
    const state = state_ || {};
    this._state = {
      filterByActiveTextEditor: state.filterByActiveTextEditor === true,
    };
    this._fileDiagnostics = new WeakMap();
  }

  consumeDatatipService(service: DatatipService): IDisposable {
    const datatipProvider: DatatipProvider = {
      // show this datatip for every type of file
      validForScope: (scope: string) => true,
      providerName: 'nuclide-diagnostics-datatip',
      inclusionPriority: 1,
      datatip: this._datatip.bind(this),
    };
    const disposable = service.addProvider(datatipProvider);
    this._subscriptions.add(disposable);
    return disposable;
  }

  async _datatip(editor: TextEditor, position: atom$Point): Promise<?Datatip> {
    const messagesForFile = this._fileDiagnostics.get(editor);
    if (messagesForFile == null) {
      return null;
    }
    const messagesAtPosition = messagesForFile.filter(
      message => message.range != null && message.range.containsPoint(position),
    );
    if (messagesAtPosition.length === 0) {
      return null;
    }
    const [message] = messagesAtPosition;
    const {range} = message;
    invariant(range);
    return {
      component: makeDiagnosticsDatatipComponent(message),
      pinnable: false,
      range,
    };
  }

  consumeDiagnosticUpdates(
    diagnosticUpdater: ObservableDiagnosticUpdater,
  ): IDisposable {
    this._getStatusBarTile().consumeDiagnosticUpdates(diagnosticUpdater);
    this._subscriptions.add(gutterConsumeDiagnosticUpdates(diagnosticUpdater));

    // Currently, the DiagnosticsView is designed to work with only one DiagnosticUpdater.
    if (this._diagnosticUpdaters.getValue() != null) {
      return new UniversalDisposable();
    }
    this._diagnosticUpdaters.next(diagnosticUpdater);
    const atomCommandsDisposable = addAtomCommands(diagnosticUpdater);
    this._subscriptions.add(atomCommandsDisposable);
    this._subscriptions.add(
      // Track diagnostics for all active editors.
      observeTextEditors((editor: TextEditor) => {
        const filePath = editor.getPath();
        if (!filePath) {
          return;
        }
        this._fileDiagnostics.set(editor, []);
        // TODO: this is actually inefficient - this filters all file events
        // by their path, so this is actually O(N^2) in the number of editors.
        // We should merge the store and UI packages to get direct access.
        const subscription = diagnosticUpdater
          .getFileMessageUpdates(filePath)
          .subscribe(update => {
            this._fileDiagnostics.set(editor, update.messages);
          });
        this._subscriptions.add(subscription);
        editor.onDidDestroy(() => {
          subscription.unsubscribe();
          this._subscriptions.remove(subscription);
          this._fileDiagnostics.delete(editor);
        });
      }),
    );
    return new UniversalDisposable(atomCommandsDisposable, () => {
      invariant(this._diagnosticUpdaters.getValue() === diagnosticUpdater);
      this._diagnosticUpdaters.next(null);
    });
  }

  consumeStatusBar(statusBar: atom$StatusBar): void {
    this._getStatusBarTile().consumeStatusBar(statusBar);
  }

  deserializeDiagnosticsViewModel(): DiagnosticsViewModel {
    return this._createDiagnosticsViewModel();
  }

  dispose(): void {
    this._subscriptions.dispose();
    if (this._statusBarTile) {
      this._statusBarTile.dispose();
      this._statusBarTile = null;
    }
  }

  serialize(): ActivationState {
    return this._state;
  }

  _createDiagnosticsViewModel(): DiagnosticsViewModel {
    return new DiagnosticsViewModel(
      this._diagnosticUpdaters.switchMap(
        updater =>
          updater == null ? Observable.of([]) : updater.allMessageUpdates,
      ),
      ((featureConfig.observeAsStream(
        'atom-ide-diagnostics-ui.showDiagnosticTraces',
      ): any): Observable<boolean>),
      showTraces => {
        featureConfig.set(
          'atom-ide-diagnostics-ui.showDiagnosticTraces',
          showTraces,
        );
      },
      disableLinter,
      observeLinterPackageEnabled(),
      this._state.filterByActiveTextEditor,
      filterByActiveTextEditor => {
        if (this._state != null) {
          this._state.filterByActiveTextEditor = filterByActiveTextEditor;
        }
      },
    );
  }

  consumeWorkspaceViewsService(api: WorkspaceViewsService): IDisposable {
    const commandDisposable = atom.commands.add(
      'atom-workspace',
      'nuclide-diagnostics-ui:toggle-table',
      event => {
        api.toggle(WORKSPACE_VIEW_URI, (event: any).detail);
      },
    );
    this._subscriptions.add(
      api.addOpener(uri => {
        if (uri === WORKSPACE_VIEW_URI) {
          return this._createDiagnosticsViewModel();
        }
      }),
      () => api.destroyWhere(item => item instanceof DiagnosticsViewModel),
      commandDisposable,
    );
    return commandDisposable;
  }

  _getStatusBarTile(): StatusBarTile {
    if (!this._statusBarTile) {
      this._statusBarTile = new StatusBarTile();
    }
    return this._statusBarTile;
  }
}

function gutterConsumeDiagnosticUpdates(
  diagnosticUpdater: ObservableDiagnosticUpdater,
): IDisposable {
  const fixer = diagnosticUpdater.applyFix.bind(diagnosticUpdater);
  return observeTextEditors((editor: TextEditor) => {
    const filePath = editor.getPath();
    if (!filePath) {
      return; // The file is likely untitled.
    }

    const callback = (update: FileMessageUpdate) => {
      // Although the subscription below should be cleaned up on editor destroy,
      // the very act of destroying the editor can trigger diagnostic updates.
      // Thus this callback can still be triggered after the editor is destroyed.
      if (!editor.isDestroyed()) {
        applyUpdateToEditor(editor, update, fixer);
      }
    };
    const disposable = new UniversalDisposable(
      diagnosticUpdater.getFileMessageUpdates(filePath).subscribe(callback),
    );

    // Be sure to remove the subscription on the DiagnosticStore once the editor is closed.
    editor.onDidDestroy(() => disposable.dispose());
  });
}

function addAtomCommands(
  diagnosticUpdater: ObservableDiagnosticUpdater,
): IDisposable {
  const fixAllInCurrentFile = () => {
    const editor = atom.workspace.getActiveTextEditor();
    if (editor == null) {
      return;
    }
    const path = editor.getPath();
    if (path == null) {
      return;
    }
    analytics.track('diagnostics-autofix-all-in-file');
    diagnosticUpdater.applyFixesForFile(path);
  };

  const openAllFilesWithErrors = () => {
    analytics.track('diagnostics-panel-open-all-files-with-errors');
    diagnosticUpdater.allMessageUpdates
      .first()
      .subscribe((messages: Array<DiagnosticMessage>) => {
        const errorsToOpen = getTopMostErrorLocationsByFilePath(messages);

        if (errorsToOpen.size > MAX_OPEN_ALL_FILES) {
          atom.notifications.addError(
            `Diagnostics: Will not open more than ${MAX_OPEN_ALL_FILES} files`,
          );
          return;
        }

        const column = 0;
        errorsToOpen.forEach((line, uri) => goToLocation(uri, line, column));
      });
  };

  return new UniversalDisposable(
    atom.commands.add(
      'atom-workspace',
      'nuclide-diagnostics-ui:fix-all-in-current-file',
      fixAllInCurrentFile,
    ),
    atom.commands.add(
      'atom-workspace',
      'nuclide-diagnostics-ui:open-all-files-with-errors',
      openAllFilesWithErrors,
    ),
    new KeyboardShortcuts(diagnosticUpdater),
  );
}

function getTopMostErrorLocationsByFilePath(
  messages: Array<DiagnosticMessage>,
): Map<string, number> {
  const errorLocations: Map<string, number> = new Map();

  messages.forEach(message => {
    if (message.scope !== 'file' || message.filePath == null) {
      return;
    }
    const filePath = message.filePath;
    // If initialLine is N, Atom will navigate to line N+1.
    // Flow sometimes reports a row of -1, so this ensures the line is at least one.
    let line = Math.max(message.range ? message.range.start.row : 0, 0);

    const prevMinLine = errorLocations.get(filePath);
    if (prevMinLine != null) {
      line = Math.min(prevMinLine, line);
    }

    errorLocations.set(filePath, line);
  });

  return errorLocations;
}

// TODO(peterhal): The current index should really live in the DiagnosticStore.
class KeyboardShortcuts {
  _subscriptions: UniversalDisposable;
  _diagnostics: Array<FileDiagnosticMessage>;
  _index: ?number;
  _traceIndex: ?number;

  constructor(diagnosticUpdater: ObservableDiagnosticUpdater) {
    this._index = null;
    this._diagnostics = [];

    this._subscriptions = new UniversalDisposable();

    const first = () => this.setIndex(0);
    const last = () => this.setIndex(this._diagnostics.length - 1);
    this._subscriptions.add(
      diagnosticUpdater.allMessageUpdates.subscribe(diagnostics => {
        this._diagnostics = (diagnostics.filter(
          diagnostic => diagnostic.scope === 'file',
        ): any);
        this._index = null;
        this._traceIndex = null;
      }),
      atom.commands.add(
        'atom-workspace',
        'nuclide-diagnostics-ui:go-to-first-diagnostic',
        first,
      ),
      atom.commands.add(
        'atom-workspace',
        'nuclide-diagnostics-ui:go-to-last-diagnostic',
        last,
      ),
      atom.commands.add(
        'atom-workspace',
        'nuclide-diagnostics-ui:go-to-next-diagnostic',
        () => {
          this._index == null ? first() : this.setIndex(this._index + 1);
        },
      ),
      atom.commands.add(
        'atom-workspace',
        'nuclide-diagnostics-ui:go-to-previous-diagnostic',
        () => {
          this._index == null ? last() : this.setIndex(this._index - 1);
        },
      ),
      atom.commands.add(
        'atom-workspace',
        'nuclide-diagnostics-ui:go-to-next-diagnostic-trace',
        () => {
          this.nextTrace();
        },
      ),
      atom.commands.add(
        'atom-workspace',
        'nuclide-diagnostics-ui:go-to-previous-diagnostic-trace',
        () => {
          this.previousTrace();
        },
      ),
    );
  }

  setIndex(index: number): void {
    this._traceIndex = null;
    if (this._diagnostics.length === 0) {
      this._index = null;
      return;
    }
    this._index = Math.max(0, Math.min(index, this._diagnostics.length - 1));
    this.gotoCurrentIndex();
  }

  gotoCurrentIndex(): void {
    invariant(this._index != null);
    invariant(this._traceIndex == null);
    const diagnostic = this._diagnostics[this._index];
    const range = diagnostic.range;
    if (range == null) {
      goToLocation(diagnostic.filePath);
    } else {
      goToLocation(diagnostic.filePath, range.start.row, range.start.column);
    }
  }

  nextTrace(): void {
    const traces = this.currentTraces();
    if (traces == null) {
      return;
    }
    let candidateTrace = this._traceIndex == null ? 0 : this._traceIndex + 1;
    while (candidateTrace < traces.length) {
      if (this.trySetCurrentTrace(traces, candidateTrace)) {
        return;
      }
      candidateTrace++;
    }
    this._traceIndex = null;
    this.gotoCurrentIndex();
  }

  previousTrace(): void {
    const traces = this.currentTraces();
    if (traces == null) {
      return;
    }
    let candidateTrace = this._traceIndex == null
      ? traces.length - 1
      : this._traceIndex - 1;
    while (candidateTrace >= 0) {
      if (this.trySetCurrentTrace(traces, candidateTrace)) {
        return;
      }
      candidateTrace--;
    }
    this._traceIndex = null;
    this.gotoCurrentIndex();
  }

  currentTraces(): ?Array<Trace> {
    if (this._index == null) {
      return null;
    }
    const diagnostic = this._diagnostics[this._index];
    return diagnostic.trace;
  }

  // TODO: Should filter out traces whose location matches the main diagnostic's location?
  trySetCurrentTrace(traces: Array<Trace>, traceIndex: number): boolean {
    const trace = traces[traceIndex];
    if (trace.filePath != null && trace.range != null) {
      this._traceIndex = traceIndex;
      goToLocation(
        trace.filePath,
        trace.range.start.row,
        trace.range.start.column,
      );
      return true;
    }
    return false;
  }

  dispose(): void {
    this._subscriptions.dispose();
  }
}

function observeLinterPackageEnabled(): Observable<boolean> {
  return Observable.merge(
    Observable.of(atom.packages.isPackageActive(LINTER_PACKAGE)),
    observableFromSubscribeFunction(
      atom.packages.onDidActivatePackage.bind(atom.packages),
    )
      .filter(pkg => pkg.name === LINTER_PACKAGE)
      .mapTo(true),
    observableFromSubscribeFunction(
      atom.packages.onDidDeactivatePackage.bind(atom.packages),
    )
      .filter(pkg => pkg.name === LINTER_PACKAGE)
      .mapTo(false),
  );
}

createPackage(module.exports, Activation);
