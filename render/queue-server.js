/*
  queue-server.js -- Queue Server for SHRDLU -- Tom Sgouros, 01/2014


  This is a server designed to work with node.js, and to keep three
  different 'queues' used to run SHRDLU on the web.  The three queues
  are as follows:

   - Actions sent from SHRDLU to the user's client display, or
     possibly to run a robot or whatever.  These are used to move the
     robot 'arm' and thus the blocks on the table.

   - Text replies (responses) from SHRDLU, such as 'ok' or 'I don't
     understand' and the like.

   - Commands sent from the user's client input to SHRDLU.  These are
     sentences like 'put the blue block in the box.' and so on.
     Punctuation is important.

  The commands are enqueued with HTTP GET requests, with the type and
  the data encased in the query string.  So
  http://example.com?act=MOVE/344/12/400 enqueues a MOVE command onto
  the queue, and http://example.com?actget=top pops the top command
  off the same queue.  The queries and queues are as follows:

  ?act=XX       enqueue an action
  ?actget=top   pop the top action off the action queue
  ?res=XX       enqueue a response
  ?resget=top   pop the top response off the response queue
  ?cmd=XX       enqueue a command
  ?cmdget=top   pop the top command off the command queue

  The 'top' business is just a placeholder.  For now it is the only
  option.

  ******  Load Balancer/Distribution 

  This server is meant to work as part of a suite of similar
  instances, with the load distributed by some kind of load balancer.
  At block.cs.brown.edu, we are using Apache, with mod_proxy_balancer.
  The instances are running on the same machine, using different
  ports.  The ports are nominated on the command line that invokes
  this server, and also in the configuration file for Apache.


  ******  SHRDLU

  In order to make this work with SHRDLU, when a user requests
  'index.html', a SHRDLU instance is launched.  This instance is
  rigged up to make regular cmdget requests looking for command
  sentences to interpret, and to enqueue responses and actions as
  necessary.  On the other side, the client should query the system
  regularly for those responses and actions.

  For more about this, see the shrdluScript itself.  It is probably at
  src/shrdlu.lisp.

  ******  Session cookies

  The SHRDLU blocks world model is not synchronized with the display.
  Rather, they both receive the same MOVE commands, and behave more or
  less the same way.  This means, however, that a single SHRDLU
  instance can accommodate only a single user at a time.  To prevent
  two users from using the same instance, this queue server uses
  session cookies.  When the instance is refreshed (upon request for
  index.html), a session cookie is recorded.  Requests that do not
  provide this cookie will not be honored.

  The format of the cookie -- SESSIONID.port -- is dictated by the
  mod_proxy_balancer module of Apache, which is used to distribute
  requests among the various instances of SHRDLU.

  <example Apache config>


  ******  Command line options

  The arguments for this command are:

    node queue-server.js host port shrdluScript [debug]

  where:

    host: the machine on which this server is to be run.  This is to
          start the node.js server, and is also used to tell the
          SHRDLU instance how to submit its queue requests.

    port: The port number on which the server is to be run, see above.

    shrdluScript: The SHRDLU script itself.  This takes host and port
          as arguments.

    debug: If there is a debug argument (no matter what it is), the
          server will be fairly liberal in its output.

TBD: 
  startup script that spawns a specified number of queue-server instances
  deny requests with the wrong session cookie
  production logging

*/
var sys = require("sys");
var http = require('http');
var url = require('url');
var path = require('path');
var fs = require('fs');
var spawn = require('child_process').spawn;
var sessions = require('./session.js');


if (process.argv.length < 5) {
    console.log("usage: node queue-server.js host port shrdluScript [debug]");
    return;
}

var host = process.argv[2];
var port = process.argv[3];
var shrdluScript = process.argv[4];

// We want this session key to expire very soon, so the system will
// welcome the first real request.
var session = sessions.create({ domain: ".cs.brown.edu", 
				port: port,
				lifetime: 5
			      });

var debug;
if (process.argv.length > 5) {
    debug = true;
} else {
    debug = false;
}


    // check out shrdluScript
fs.stat(shrdluScript, function (err, stats) { 
    try {
	if (!(stats.isFile() && 
	      (1 & parseInt((stats.mode & parseInt("777", 8))
			    .toString(8)[0])))) {
	    console.log(shrdluScript + " not executable.");
	    process.exit(1);
	}
    } catch(err) {
	console.log("problem with file " + shrdluScript + ".  Probably not found ");
	process.exit(1);
    }
});
// This will be restarted as soon as someone asks for the index.html
// file, so it doesn't have to run detached yet.  This process will
// never be used, but it's less trouble to start it here and kill it
// later.
var shrdluDir = shrdluScript.substring(0, shrdluScript.lastIndexOf('/') + 1);

var shrdluProcess = spawn(shrdluScript, [shrdluDir, host, port]);

var moveQueue = Array();
var cmdQueue = Array();
var resQueue = Array();

var counter = 0;
var outstring = '-empty-';

var prevConsoleString = "";
var prevConsoleCount = 0;
function printConsole(str) {
    if (str.localeCompare(prevConsoleString) == 0) {
	prevConsoleCount++;
	process.stdout.write(str + " (" + prevConsoleCount.toString() + ")\r");
    } else {
	prevConsoleCount = 0;
	process.stdout.write("\n" + str + "\r");
    }

    prevConsoleString = str;
}

http.createServer(function (request, response) {
    var pathname = url.parse(request.url).pathname;
    var queryData  = url.parse(request.url, true).query;

    // console.log(request.headers);
    // console.log("****" + url.parse(request.url).pathname);
    // console.log("^^^^" + request.url + "<<<");

    // for (var entry in queryData) {
    // 	console.log("+++" + entry + "->(" + queryData[entry] + ")"); }

    // console.log(Object.keys(queryData).length);

    var cookies = {};

    // If the current session cookie is stale, don't reject any request.
    var reject = (!session.staleCookie());

    request.headers.cookie && request.headers.cookie.split(';').forEach(function(cookie) {
	var parts = cookie.split('=');
	cookies[ parts[0].trim() ] = ( parts[1] || '').trim();

	// If the session cookie matches, honor this request.
	if (parts[0].trim().match(/SID/) && 
	    session.matchCookie(parts[1].trim())) {
	    reject = false;
	    printConsole(session.staleCookie() + " " + reject);
	}

	if (debug) 
	    console.log("cookie found (" + request.url + "): " + parts[0].trim() + " = " + (parts[1] || '').trim());
    });

    counter++;

    if ((pathname == "/") && (Object.keys(queryData).length == 0)) {
	pathname = "/index.html";
    }

    if (debug) {

	if (moveQueue.length > 0) 
	    printConsole("moveQueue:[" + moveQueue.toString() + "]");
	if (cmdQueue.length > 0)
	    printConsole("cmdQueue:[" + cmdQueue.toString() + "]");
	if (resQueue.length > 0)
	    printConsole("resQueue:[" + resQueue.toString() + "]");

	if ( !(queryData.act === undefined))
	    printConsole('act-->' + queryData.act);
	if ( !(queryData.actget === undefined))
	    printConsole('actget-->' + queryData.actget);
	if ( !(queryData.cmd === undefined))
	    printConsole('cmd-->' + queryData.cmd);
	if ( !(queryData.cmdget === undefined))
	    printConsole('cmdget-->' + queryData.cmdget);
	if ( !(queryData.res === undefined))
	    printConsole('res-->' + queryData.res);
	if ( !(queryData.resget === undefined))
	    printConsole('resget-->' + queryData.resget);
    }

    var out;

    // The SHRDLU instance does not need to use session cookies, but
    // the user's client does.  The messages that check for reject
    // below are the ones we expect from the user's client.
    if (queryData.act) {

	moveQueue.push(queryData.act);

	out = queryData.act;

    } else if ((!reject) && queryData.actget) {

	if (moveQueue.length > 0) {

	    out = moveQueue[0];
	    moveQueue.splice(0, 1);

	} else {

	    out = outstring;

	}
    } else if ((!reject) && queryData.cmd) {

	cmdQueue.push(queryData.cmd);

	out = queryData.cmd;

    } else if (queryData.cmdget) {

	if (cmdQueue.length >0) {

	    out = cmdQueue[0];
	    cmdQueue.splice(0, 1);

	} else {

	    out = outstring;

	}

    } else if (queryData.res) {

	resQueue.push(queryData.res);

	out = queryData.res;

    } else if ((!reject) && queryData.resget) {

	if (resQueue.length >0) {

	    out = resQueue[0];
	    resQueue.splice(0, 1);

	} else {

	    out = outstring;

	}

    } else {

	// If the session cookie doesn't match the one we are holding,
	// then refuse the connection.
	if (reject) {
    	    response.writeHead(503, {"Content-Type": "text/plain"});
    	    response.end("503 Busy\n");
    	    return;
	}

	// Session cookie matches local version, or local version
	// stale, no query string.  Must just want a file.
	var filename = path.join(process.cwd(), pathname);

	// If we want the index.html, restart the shrdlu process
	// because we're restarting the display window.
	if (/index.html/g.test(filename)) {

	    shrdluProcess.kill();

	    shrdluProcess = spawn(shrdluScript, [shrdluDir, host, port], 
				  {detached: true, stdio: ['ignore']} );

	    if (debug) {
		shrdluProcess.stdout.on('data', function (data) {
		    printConsole('stdout: ' + data);
		});

		shrdluProcess.stderr.on('data', function (data) {
		    printConsole('stderr: ' + data);
		});

		shrdluProcess.on('close', function (code) {
		    printConsole('child process exited with code ' + code);
		});
	    }

	    shrdluProcess.on('error', function (err) { 
		printConsole(">>>" + err); } );

	    shrdluProcess.unref();

	    // Renew the cookies
	    session = sessions.lookupOrCreate(request, {
		lifetime: 5400,
		domain: ".cs.brown.edu",
		port: port
	    });

	    if (debug) {
		printConsole("cookie: " + session.getSetCookieSessionValue());
	    }

	}

	fs.exists(filename, function(exists) {
    	    if (!exists) {
    		response.writeHead(404, {"Content-Type": "text/plain"});
    		response.end("404 Not Found\n");
    	    } else {
    		fs.readFile(filename, "binary", function(err, file) {
    		    if(err) {
    			response.writeHead(500, {"Content-Type": "text/plain"});
    			response.end(err + "\n");
    		    } else {

			var fileType, contentType;

			if (filename.match(/\.js/g)) {
			    contentType = "application/javascript";
			    fileType = "utf8";

			} else if (filename.match(/\.css/g)) {
			    contentType = "text/css";
			    fileType = "utf8";

			} else if (filename.match(/\.png/g)) {
			    contentType = "image/png";
			    fileType = "binary";

			} else {
			    contentType = "text/html";
			    fileType = "utf8";
			}

			if (debug) {
			    printConsole("sending: " + filename + " (" + fileType + ", " + contentType + ")");
			    printConsole("cookie:" + session.getSetCookieSessionValue());
			}

			response.writeHead(200, [
			    ["Content-Type", contentType ],
			    ["Set-Cookie", session.getSetCookieSessionValue()]
			]);

			response.write(file, fileType);
    			response.end();
		    }
		});
	    }
	});

	out = '';
    }

    if (out) {
	response.writeHead(200, [
	    ["Content-Type", "text/plain" ],
	    ["Set-Cookie", session.getSetCookieSessionValue()]
	]);

	response.end(out + '\n');
    }

}).listen(port, host);

console.log('Server running at http://' + host + ":" + port);