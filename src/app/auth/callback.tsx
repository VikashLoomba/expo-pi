import { Redirect } from 'expo-router';

/** Configured mobile OAuth clients return here; the native auth session consumes the response. */
export default function AuthCallback() {
  return <Redirect href="/account" />;
}
