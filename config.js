// Portal settings. Everything here is safe to be public (GitHub Pages):
// no ClickUp, Drive or other secrets ever go in this file. They live in
// Firebase secrets, used only by the backend functions.
window.PORTAL_CONFIG = {
  // 'mock' = sample data, nothing leaves the browser. 'live' = Firebase sign-in + backend.
  mode: new URLSearchParams(location.search).get('mock') === '1' ? 'mock' : 'live',

  // Same Firebase project as the availability calendar, for testing.
  firebase: {
    apiKey: 'AIzaSyCJBHYoYk7fG-5h-tAcU897ySV4AUbThPY',
    authDomain: 'blugibbon-av-cal-2.firebaseapp.com',
    databaseURL: 'https://blugibbon-av-cal-2-default-rtdb.firebaseio.com',
    projectId: 'blugibbon-av-cal-2'
  },

  // Files go straight to Drive, so the only limit is ours.
  maxUploadBytes: 50 * 1024 * 1024
};
