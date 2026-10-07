#!/usr/bin/env node
import { runNativeRemoteProbe } from './lib/native-remote-runner.mjs';
await runNativeRemoteProbe('native-ssh-ui-probe', 'check-native-remote-ui.mjs');
