import { withOnBootNetworkActivityRecording } from '@rozenite/network-activity-plugin';
import { registerRootComponent } from 'expo';

import App from './App';

// Start recording network activity before the app boots, so no request is missed.
withOnBootNetworkActivityRecording();

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
