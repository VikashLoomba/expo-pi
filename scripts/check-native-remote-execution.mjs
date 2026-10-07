#!/usr/bin/env node
import { runNativeRemoteProbe } from './lib/native-remote-runner.mjs';
await runNativeRemoteProbe('native-ssh-execution-probe', 'check-native-remote-execution.mjs');
