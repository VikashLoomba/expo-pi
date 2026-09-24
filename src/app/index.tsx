import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CODEX_PROVIDER_ID, createCodexSession, MODEL_ID, openCodexDeviceBrowser } from '@/pi/codex-auth';
import { DEFAULT_PROMPT, emptyProgress, runHarness, runtimeCapabilities } from '@/pi/harness';

export default function HomeScreen() {
  const [models] = useState(createCodexSession);
  const [signedIn, setSignedIn] = useState(false);
  const [authStatus, setAuthStatus] = useState('Sign in with your ChatGPT account.');
  const [signingIn, setSigningIn] = useState(false);
  const [deviceLogin, setDeviceLogin] = useState<{ userCode: string; verificationUri: string } | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [progress, setProgress] = useState(emptyProgress);
  const [running, setRunning] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.current?.abort(); };
  }, []);

  const signIn = async () => {
    if (controller.current) return;
    const current = new AbortController();
    controller.current = current;
    setSigningIn(true);
    setDeviceLogin(null);
    try {
      await models.login(CODEX_PROVIDER_ID, 'oauth', {
        signal: current.signal,
        prompt: async () => { throw new Error('Unexpected interactive prompt.'); },
        notify: (event) => {
          if (!mounted.current) return;
          if (event.type === 'progress') setAuthStatus(event.message);
          if (event.type === 'device_code') {
            setDeviceLogin({ userCode: event.userCode, verificationUri: event.verificationUri });
            setAuthStatus('Enter this one-time code on the OpenAI sign-in page.');
          }
        },
      });
      if (mounted.current) { setSignedIn(true); setAuthStatus('Signed in with ChatGPT.'); }
    } catch (error) {
      if (mounted.current) setAuthStatus(current.signal.aborted || (error instanceof Error && error.name === 'AbortError')
        ? 'Sign-in cancelled.' : error instanceof Error ? error.message : 'Sign-in failed.');
    } finally {
      // Close any device-code browser after success, failure or cancellation.
      current.abort();
      controller.current = null;
      if (mounted.current) { setSigningIn(false); setDeviceLogin(null); }
    }
  };

  const openSignInPage = async () => {
    const current = controller.current;
    if (!current || !deviceLogin || browserOpen) return;
    setBrowserOpen(true);
    try {
      await openCodexDeviceBrowser(current.signal);
    } catch (error) {
      if (mounted.current && !current.signal.aborted) setAuthStatus(error instanceof Error ? error.message : 'Could not open sign-in.');
    } finally {
      if (mounted.current) setBrowserOpen(false);
    }
  };

  const signOut = async () => {
    if (controller.current) return;
    await models.logout(CODEX_PROVIDER_ID);
    setSignedIn(false);
    setAuthStatus('Signed out. Credentials cleared from memory.');
    setProgress(emptyProgress());
  };

  const start = async () => {
    if (controller.current) return;
    const current = new AbortController();
    controller.current = current;
    setRunning(true);
    try {
      await runHarness({ models, prompt, signal: current.signal, onProgress: (next) => {
        if (mounted.current) setProgress(next);
      } });
    } catch (error) {
      if (mounted.current) setProgress((previous) => ({ ...previous,
        status: current.signal.aborted ? 'Cancelled' : 'Failed',
        error: current.signal.aborted ? undefined : error instanceof Error ? error.message : String(error),
      }));
    } finally {
      controller.current = null;
      if (mounted.current) setRunning(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.eyebrow}>PI · ON DEVICE</Text>
        <Text style={styles.title}>Agent Harness</Text>
        <Text style={styles.description}>Stream a response, run a local tool, and continue the conversation.</Text>
        <Text style={styles.description}>{MODEL_ID} · OpenAI Codex</Text>
        <Text style={styles.description}>Sign in with ChatGPT. Tokens stay in memory until you sign out or close the app.</Text>
        <Text testID="auth-status" style={styles.description}>{authStatus}</Text>
        <View style={styles.row}>
          <Pressable testID="sign-in" accessibilityRole="button" disabled={running || signingIn || signedIn} onPress={signIn}
            style={[styles.primary, (running || signingIn || signedIn) && styles.disabled]}>
            <Text style={styles.buttonText}>{signingIn ? 'Signing in…' : 'Sign in with ChatGPT'}</Text>
          </Pressable>
          {signedIn && <Pressable testID="sign-out" accessibilityRole="button" disabled={running} onPress={signOut}
            style={[styles.tab, running && styles.disabled]}><Text style={styles.buttonText}>Sign out</Text></Pressable>}
          {signingIn && <Pressable testID="cancel-sign-in" accessibilityRole="button" onPress={() => controller.current?.abort()}
            style={styles.tab}><Text style={styles.buttonText}>Cancel</Text></Pressable>}
        </View>
        {deviceLogin && <View style={styles.card}>
          <Text selectable testID="device-code" style={styles.status}>{deviceLogin.userCode}</Text>
          <Text selectable style={styles.description}>{deviceLogin.verificationUri}</Text>
          <Text style={styles.description}>Open the sign-in page here, or visit this address on your phone and enter the code. Keep this app open while you approve access.</Text>
          <Pressable testID="open-sign-in-page" accessibilityRole="button" disabled={browserOpen} onPress={openSignInPage}
            style={[styles.primary, browserOpen && styles.disabled]}>
            <Text style={styles.buttonText}>Open sign-in page</Text>
          </Pressable>
        </View>}
        <TextInput testID="prompt" accessibilityLabel="Prompt" multiline value={prompt} onChangeText={setPrompt}
          editable={!running && !signingIn} style={[styles.input, styles.prompt]} />
        <View style={styles.row}>
          <Pressable testID="run" accessibilityRole="button" disabled={running || signingIn || !prompt.trim() || !signedIn} onPress={start}
            style={[styles.primary, (running || signingIn || !prompt.trim() || !signedIn) && styles.disabled]}><Text style={styles.buttonText}>Run prompt</Text></Pressable>
          <Pressable testID="cancel" accessibilityRole="button" disabled={!running} onPress={() => controller.current?.abort()}
            style={[styles.tab, !running && styles.disabled]}><Text style={styles.buttonText}>Cancel</Text></Pressable>
        </View>
        <View style={styles.card}>
          <Text testID="status" style={styles.status}>{progress.status}</Text>
          <Text testID="counts" style={styles.description}>{progress.deltas} text deltas · {progress.tools} tool calls</Text>
          <Text testID="response" selectable style={styles.response}>{progress.text || 'Assistant output will appear here.'}</Text>
          {progress.toolResult && <Text testID="tool-result" selectable style={styles.code}>{progress.toolResult}</Text>}
          {progress.error && <Text testID="run-error" selectable style={styles.error}>{progress.error}</Text>}
        </View>
        <Text style={styles.heading}>Runtime capabilities</Text>
        <Text testID="capabilities" selectable style={styles.code}>{JSON.stringify(runtimeCapabilities(), null, 2)}</Text>
        <Text style={styles.heading}>Harness events</Text>
        <Text testID="events" selectable style={styles.code}>{progress.events.join('\n') || 'Waiting for a prompt.'}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#101820' },
  content: { padding: 24, paddingBottom: 110, gap: 16 },
  eyebrow: { color: '#7be4bd', fontSize: 12, fontWeight: '700', letterSpacing: 2 },
  title: { color: '#f3f7fa', fontSize: 34, fontWeight: '700' },
  description: { color: '#a9b9c8', fontSize: 14, lineHeight: 21 },
  row: { flexDirection: 'row', gap: 12 },
  tab: { padding: 14, borderRadius: 12, backgroundColor: '#263543' },
  selected: { backgroundColor: '#27644f' },
  primary: { flex: 1, padding: 14, borderRadius: 12, backgroundColor: '#246b55', alignItems: 'center' },
  buttonText: { color: '#f3f7fa', fontSize: 15, fontWeight: '600' },
  disabled: { opacity: 0.4 },
  input: { color: '#f3f7fa', backgroundColor: '#1b2935', padding: 16, borderRadius: 12, fontSize: 15 },
  prompt: { minHeight: 96, textAlignVertical: 'top' },
  card: { backgroundColor: '#1b2935', padding: 18, borderRadius: 16, gap: 12 },
  status: { color: '#7be4bd', fontSize: 18, fontWeight: '600' },
  response: { color: '#f3f7fa', fontSize: 17, lineHeight: 25 },
  code: { color: '#a9b9c8', fontFamily: 'monospace', fontSize: 12, lineHeight: 19 },
  error: { color: '#ffa797', lineHeight: 21 },
  heading: { color: '#e3ebf1', fontSize: 16, fontWeight: '600' },
});
