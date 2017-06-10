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

import type {NuclideUri} from 'nuclide-commons/nuclideUri';
import type {Device, Process, ProcessTask} from '../types';
import type {Expected} from '../../../nuclide-expected';
import type {TaskEvent} from 'nuclide-commons/process';
import type {Props as TaskButtonPropsType} from './TaskButton';

import {bindObservableAsProps} from 'nuclide-commons-ui/bindObservableAsProps';
import {TaskButton} from './TaskButton';
import {DeviceTask} from '../DeviceTask';
import React from 'react';
import {
  PanelComponentScroller,
} from 'nuclide-commons-ui/PanelComponentScroller';
import invariant from 'invariant';
import {Selectors} from './Selectors';
import {DeviceTable} from './DeviceTable';
import {DevicePanel} from './DevicePanel';

export type Props = {|
  setHost: (host: NuclideUri) => void,
  setDeviceType: (deviceType: string) => void,
  setDevice: (device: ?Device) => void,
  toggleDevicePolling: (isActive: boolean) => void,
  toggleProcessPolling: (isActive: boolean) => void,
  processTasks: ProcessTask[],
  hosts: NuclideUri[],
  devices: Expected<Device[]>,
  host: NuclideUri,
  deviceTypes: string[],
  deviceType: ?string,
  deviceTasks: DeviceTask[],
  device: ?Device,
  infoTables: Map<string, Map<string, string>>,
  processes: Process[],
  isDeviceConnected: boolean,
  deviceTypeTasks: DeviceTask[],
|};

export class RootPanel extends React.Component {
  props: Props;

  constructor(props: Props) {
    super(props);
    invariant(props.hosts.length > 0);
    (this: any)._goToRootPanel = this._goToRootPanel.bind(this);
  }

  componentDidMount(): void {
    this.props.toggleDevicePolling(true);
  }

  componentWillUnmount(): void {
    this.props.toggleDevicePolling(false);
  }

  _createDeviceTable(): ?React.Element<any> {
    if (this.props.deviceType === null) {
      return null;
    }
    return (
      <DeviceTable
        devices={this.props.devices}
        device={this.props.device}
        setDevice={this.props.setDevice}
      />
    );
  }

  _taskEventsToProps(
    task: DeviceTask,
    taskEvent: ?TaskEvent,
  ): TaskButtonPropsType {
    return {
      name: task.getName(),
      start: () => task.start(),
      cancel: () => task.cancel(),
      isRunning: taskEvent != null,
      progress: null,
    };
  }

  _getTasks(): React.Element<any> {
    const tasks = Array.from(this.props.deviceTypeTasks).map(task => {
      const StreamedTaskButton = bindObservableAsProps(
        task
          .getTaskEvents()
          .distinctUntilChanged()
          .map(taskEvent => this._taskEventsToProps(task, taskEvent)),
        TaskButton,
      );
      return <StreamedTaskButton key={task.getName()} />;
    });
    return (
      <div className="block nuclide-device-panel-tasks-container">
        {tasks}
      </div>
    );
  }

  _goToRootPanel(): void {
    this.props.setDevice(null);
  }

  _getInnerPanel(): React.Element<any> {
    if (this.props.device != null) {
      return (
        <div className="block">
          <DevicePanel
            infoTables={this.props.infoTables}
            processes={this.props.processes}
            processTasks={this.props.processTasks}
            deviceTasks={this.props.deviceTasks}
            goToRootPanel={this._goToRootPanel}
            toggleProcessPolling={this.props.toggleProcessPolling}
            isDeviceConnected={this.props.isDeviceConnected}
          />
        </div>
      );
    }
    return (
      <div>
        <div className="block">
          <Selectors
            deviceType={this.props.deviceType}
            deviceTypes={this.props.deviceTypes}
            hosts={this.props.hosts}
            host={this.props.host}
            setDeviceType={this.props.setDeviceType}
            setHost={this.props.setHost}
          />
        </div>
        <div className="block">
          {this._createDeviceTable()}
        </div>
        {this._getTasks()}
      </div>
    );
  }

  render(): React.Element<any> {
    return (
      <PanelComponentScroller>
        <div className="nuclide-device-panel-container">
          {this._getInnerPanel()}
        </div>
      </PanelComponentScroller>
    );
  }
}
