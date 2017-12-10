const SpotifyWebApi = require('spotify-web-api-node');

const spotify = new SpotifyWebApi({
  clientId: '8698eaf4a6254e5eb8cfa30333faef1f',
  clientSecret: '1912e260111249668f98ff1777a441cd',
  redirectUri: 'http://localhost:3030/api/auth/callback'
});

function refreshAccessToken() {
  spotify.clientCredentialsGrant().then(data => {
    const access_token = data.body['access_token'],
          expires_in_ms = parseInt(data.body['expires_in'], 10) * 1000;
          
    spotify.setAccessToken(access_token);
    
    /* Automatically refresh after expiration period */
    setTimeout(() => {
      refreshAccessToken();
    }, expires_in_ms);
  });
}

refreshAccessToken();

module.exports = spotify;