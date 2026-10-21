import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DocZipAPI } from '../shared/types';

const api: DocZipAPI = {
  getState: () => ipcRenderer.invoke('queue:get'),
  chooseOutput: () => ipcRenderer.invoke('settings:output'),
  setPreset: preset => ipcRenderer.invoke('settings:preset', preset),
  pickFiles: () => ipcRenderer.invoke('files:pick'),
  addDroppedFiles: files => ipcRenderer.invoke('files:add', files.map(file => webUtils.getPathForFile(file)).filter(Boolean)),
  start: () => ipcRenderer.invoke('queue:start'),
  pause: () => ipcRenderer.invoke('queue:pause'),
  cancel: id => ipcRenderer.invoke('queue:cancel', id),
  remove: id => ipcRenderer.invoke('queue:remove', id),
  clearFinished: () => ipcRenderer.invoke('queue:clear'),
  openOutput: () => ipcRenderer.invoke('output:open'),
  showResult: id => ipcRenderer.invoke('output:show', id),
  onState: callback => {
    const listener = (_event: Electron.IpcRendererEvent, state: Parameters<typeof callback>[0]) => callback(state);
    ipcRenderer.on('queue:state', listener);
    return () => ipcRenderer.removeListener('queue:state', listener);
  },
};
contextBridge.exposeInMainWorld('doczip', api);
