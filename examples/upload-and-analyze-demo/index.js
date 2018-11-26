'use strict';

const Config = require( './config' );
const SEAPIClient = require( '@simple-emotion/api-client' );
const { promisify: p } = require( 'util' );
const fs = require( 'fs' );
const path = require( 'path' );
const crypto = require( 'crypto' );
const mkdirp = p( require( 'mkdirp' ) );
const express = require( 'express' );
const request = require( 'request' );
const bufferEq = require( 'buffer-equal-constant-time' );

const OWNER = Config.owner;
const CALLBACK_SECRET = Config.webhook.secret;
const STORAGE_DIR = path.resolve( Config.server.storagePath );

// Set up api
const SEAPI = SEAPIClient(
  Config.api.credentials.client_id,
  Config.api.credentials.client_secret,
  {
    host: Config.api.url,
    scope: [
      'oauth2',
      'callcenter',
      'operation',
      'storage',
      'webhook'
    ]
  }
);

module.exports.handler = handler;

if ( require.main === module ) {

  const cmd = process.argv[ 2 ];
  const url = process.argv[ 3 ];

  if ( !cmd || !url ) {
    throw new Error( `Must specify ${cmd ? 'URL' : 'ACTION'}.` );
  }

  switch ( cmd ) {
    case 'server':
      server( url ).then().catch( err => {
        console.error( err );
        process.exit( 1 );
      } );
      break;
    case 'upload':
      upload( url ).then( result => {
        console.log( JSON.stringify( result ) );
        process.exit( 0 );
      } ).catch( err => {
        console.error( err );
        process.exit( 1 );
      } );
      break;
    default:
      throw new Error( 'Unsupported CLI operation type. Refer to README for useage examples.' );
  }

}

async function server( callback_url ) {

  // Ensure that a webhook exists for the specified URI
  console.log( '[!] Ensuring webhook exists.' );
  await ensureWebhook( callback_url );

  // Make sure storage directory exists
  if ( !process.env.GCP_PROJECT ) {
    await mkdirp( STORAGE_DIR );
  }

  console.log( '[!] Starting server.' );

  // Create an express server
  const app = express();
  const server = require( 'http' ).createServer( app );

  app.use( require( 'body-parser' ).json( { strict: true } ) );

  // Get path from url
  const path = new URL( callback_url ).pathname;

  // Handle webhook post request path
  app.post( path, handler );

  server.listen( Config.server.port );
  console.log( `[!] Server listening on port ${Config.server.port}.` );

}

async function upload( url, tags ) {

  // Add audio file
  const { audio } = await p( SEAPI.storage.v2.audio.add )(
    {
      audio: {
        name: path.basename( url ),
        owner: OWNER,
        metadata: {
          speakers: [
            { _id: 'speakerCh0', role: 'agent' },
            { _id: 'speakerCh1', role: 'customer' }
          ]
        }
      }
    }
  );

  // Upload raw audio data
  const { operation } = await p( SEAPI.storage.v2.audio.uploadFromUrl )(
    {
      audio: {
        _id: audio._id,
        owner: OWNER
      },
      url,
      operation: {
        tags: [ `audio_id=${audio._id}`, ... ( tags || [] ) ]
      }
    }
  );

  return { audio: { _id: audio._id }, operation: { _id: operation._id } };

}

async function handler( req, res ) {
  try {

    // Extract signature and payload from request for verification
    const signature = req.get( 'X-SE-Signature' ) || '';
    const payload = JSON.stringify( req.body || '' );

    // Compute signature from payload
    const computed_signature = sign( CALLBACK_SECRET, payload );

    // Securely verify signatures match
    if ( !equal( signature, computed_signature ) ) {
      res.statusCode = 200;
      res.write( 'Signature mismatch. Received invalid webhook.' );
      return res.end();
    }

    // Response must echo webhook challenge
    res.set( 'X-SE-Challenge', req.get( 'X-SE-Challenge' ) );

    // Extract event
    const event_type = req.body.event.type;

    // Not an operation complete event so we can ignore it in this demo.
    if ( event_type !== 'operation.complete' ) {
      console.warn( `Received unhandleable event type: ${event_type}` );
      res.statusCode = 200;
      return res.end();
    }

    const { operation } = req.body.data;
    const audio_id = operation.parameters.audio_id;

    if ( operation.error && operation.error.code !== 409 ) {
      console.error( `[!] Operation (${operation._id}) for audio (${audio_id}) failed!` );
      console.error( '[!]', JSON.stringify( operation.error, null, 2 ) );
      res.statusCode = 200;
      return res.end();
    }

    if ( operation.type === 'transload-audio' ) {
      await analyzeAudio( audio_id );
    }

    else if ( operation.type === 'classify-transcript' ) {
      await downloadTranscript( operation );
    }

    else {
      console.warn( `Received unhandleable operation type: ${operation.type}` );
    }

    res.statusCode = 200;
    res.end();

  }
  catch ( err ) {

    if ( !err.code ) {
      err = {
        code: 500,
        err: err.message
      };
    }

    res.statusCode = err.code;
    res.json( err );
    res.end();

  }
}

async function analyzeAudio( audio_id ) {

  const { operation } = await p( SEAPI.callcenter.v2.transcript.classify )(
    {
      audio: {
        _id: audio_id,
        owner: OWNER
      },
      operation: {
        config: {
          'transcribe-audio': {
            redact: false,        // Set to true to scrub any numbers that may contain personal data
            languageCode: 'en-US' // Change the transcription language with this
          }
        },
        tags: [
          'audio._id=' + audio_id
        ]
      }
    }
  );

  console.log( `Created classify-transcript operation (${operation._id}) for audio (${audio_id}).` );

}

async function downloadTranscript( operation ) {

  const { document } = await p( SEAPI.storage.v2.document.getLink )(
    {
      document: operation.result.document.transcript
    }
  );

  if ( process.env.GCP_PROJECT ) {
    console.log( 'Classified-transcript download link:', document.link );
  }
  else {

    const filename = path.resolve( STORAGE_DIR, operation.parameters.audio_id ) + '.json';

    await downloadFile( document.link, filename );

    console.log( `Classified-transcript downloaded (${filename}).` );

  }

}

async function ensureWebhook( url ) {

  const webhook = await p( SEAPI.webhook.v1.list )(
    {
      webhook: {
        owner: OWNER,
        event: {
          type: 'operation.complete'
        },
        states: {
          enabled: true
        }
      }
    }
  ).then( result => result.webhooks.find( w => w.url === url ) );

  if ( webhook ) {
    return webhook;
  }

  // Set up webhook for operation.complete event
  return p( SEAPI.webhook.v1.add )(
    {
      webhook: {
        owner: OWNER,
        event: {
          type: 'operation.complete'
        },
        url: url,
        secret: CALLBACK_SECRET
      }
    }
  ).then( result => result.webhook );

}

async function downloadFile( url, filename ) {
  return new Promise( ( resolve, reject ) => {

    let returned = false;

    const done = err => {
      if ( !returned ) {

        returned = true;

        err ? reject( err ) : resolve();

      }
    };

    // Get request to the URL
    request( { url } )
      .on( 'error', done )
      .on( 'response', read => {

        if ( read.statusCode >= 300 ) {
          return done( new Error( `Unable to download file (${read.statusCode}) from url: ${url}` ) );
        }

        // Stream the contents to a local file
        const write = fs.createWriteStream( filename )
                        .on( 'error', done )
                        .on( 'finish', done );

        read.on( 'error', done ).pipe( write );

      } );

  } );
}

function equal( a, b ) {
  return bufferEq( Buffer.from( a ), Buffer.from( b ) );
}

function sign( secret, data ) {
  return crypto.createHmac( 'sha1', secret ).update( data ).digest( 'hex' );
}
