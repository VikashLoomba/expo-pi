import { runNativeRemoteProbe } from './lib/native-remote-runner.mjs';
await runNativeRemoteProbe('native-ssh-bootstrap-probe', 'check-native-remote-bootstrap.mjs');
