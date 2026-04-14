import { useEffect } from "react";
import { Redirect } from "expo-router";

// This route catches the juke://auth/callback deep link from SIWN.
// The NeynarSigninButton WebView handles the actual callback internally;
// this screen just redirects home if the user lands here directly.
export default function AuthCallback() {
  return <Redirect href="/" />;
}
