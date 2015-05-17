// app.js
// Application for Massdrop Coding Challenge

// Brett Levenson, 5/14/15
// Description:
/**
* 
* Create a job queue whose workers fetch data from a URL and store the results in a database.  The job queue should expose a REST API for adding jobs and checking their status / results.
* Example:
* User submits www.google.com to your endpoint.  The user gets back a job id. Your system fetches www.google.com (the result of which would be HTML) and stores the result.  The user asks for the status of the job id and if the job is complete, he gets a response that includes the HTML for www.google.com.
* **/


// Init the packages we will need
var express = require("express"),
	kue = require("kue"),
	bodyParser = require("body-parser"),
	request = require("request"),
	extend = require("util")._extend, // I need to be able to copy the body object that comes through
	app = express();

// Create the jobs queue
var jobs = kue.createQueue();

// We'll also want to make it easier to access the redis client that Kue creates
var rdclient = kue.Job.client;

// Set up body parser for processing POSTs
app.use(bodyParser.urlencoded({extended: true}));

// Some logic that should be outside of express middlware
// Creating some functions to avoid some of the right drift in jobs.process
var makeGetRequest = function(job, done) {
	var r = request.get(job.data.url, function(err, resp, body) {
		// Now we'll decide what to do based on the results of the request
		if(err || resp.statusCode !== 200) {
			console.log("An error occurred while making the GET request:", err);
			console.log("The status code was:", resp.statusCode);

			// Write the statusCode to Redis for later retrieval
			rdclient.hmset(['q:job:'+job.id, 'respBody', 'Error', 'respStatus', resp.statusCode ], function(redisError, redisResult) {
				if(redisError) {
					console.log("An error occurred while saving to Redis:", redisError);
					return done(redisError);
				}
			});
			// All is not good in the hood, so end processing and throw the error returned by request
			return done(err);
		};

		// Now attach the results to the job itself in Redis
		rdclient.hmset(['q:job:'+job.id, 'respBody', body, 'respContentType', resp.headers['content-type'] ], function(redisError, redisResult) {
			if(redisError) 
				return done(redisError); // end if an error occurred.

			// End processing now that we've stored the data in Redis
			return done(); 
		});
	});
}

// Creating some functions to avoid some of the right drift in jobs.process
var makePostRequest = function(job, done) {
	console.log("Making a post request with the following params:", job.data.params);
	var r = request.post({ url: job.data.url, form: job.data.params }, function(err, resp, body) {
		// Now we'll decide what to do based on the results of the request
		if(err || (resp.statusCode !== 200 && resp.statusCode !== 201)) { // 200 OK, or 201 Created are both ok
			// All is not good in the hood, so end processing and throw the error returned by request
			console.log("An error occurred during the POST request:", err);
			console.log("The status code was:", resp.statusCode);

			// Write the nature of the error to Redis for later retrieval
			rdclient.hmset(['q:job:'+job.id, 'respBody', 'Error', 'respStatus', resp.statusCode ], function(redisError, redisResult) {
				if(redisError) {
					console.log("An error occurred while saving to Redis:", redisError);
					return done(redisError);
				}
			});

			return done(err);
		};

		// Now attach the results to the job itself in Redis
		console.log("response body:", body);
		console.log("respContentType:", resp.headers["content-type"]);
		rdclient.hmset(['q:job:'+job.id, 'respBody', body, 'respContentType', resp.headers['content-type'] ], function(redisError, redisResult) {
			if(redisError) 
				return done(redisError); // end if an error occurred.

			// End processing now that we've stored the data in Redis
			return done(); 
		});
	});
}

// Set the event handlers for HTTP request jobs using GET and POST
jobs.process('get', makeGetRequest);
jobs.process('post', makePostRequest);

// GET job by id
app.get('/jobs/:id', function(req, res) {
	var jobId = req.params.id;

	// Look up the job in the redis db
	rdclient.hmget(['q:job:'+jobId, 'respBody', 'respContentType', 'respStatus'], function(redisError, response) {
		if(redisError) {
			res.set('Content-Type', 'text/html');
			res.send("<h2>Job " + jobId + " not yet complete.</h2><p><a href=\"/jobs/"+jobId+"\">Click to Repeat Your Request</a></p>");
		} else if(response[0] === "Error") {
			// If a statusCode other than 200 (or 201 for POST requests) is received, we'll fill respBody[0] with 'Error'
			res.set('Content-Type', 'text/plain');
			res.send("Something went wrong during your request. (StatusCode was: "+response[2]+") Please try again.\n");
		} else if(!response[0]) {
			res.set('Content-Type', 'text/html');
			res.send("<h2>Job "+jobId+":<p>The response was empty. This may have been an error or this could be the standard response for the request you made.</p>");
		} else {
			// Grab data from redis
			var contentType = response[1];
			var content = response[0];

			// Send back the result
			res.set('Content-Type', contentType);
			res.send(content);
		}
	});
});

// Here's a post version of the add to queue endpoint
app.route('/jobs')
	.all(function(req, res, next) {
		// Create function: (set up for creation by either get or post)
		// verb: the HTTP verb to use for the request
		// url: the URL for the API call
		// params: An object with key:value pairs (optional for get, required for post)
		// cb: A callback to execute the response to the client

		req.create = function(verb, url, params, cb) {

			// Do some error checking to make sure all post requests include a params object
			if(verb === 'post' && !params) {
				throw new Error("A post request must include a params object.");
				return;
			}

			// So, we create a new job
			var job = jobs.create(verb, { url: url, params: params });

			// Now set some event handlers for success and failure
			job.on('complete', function() {
				console.log('JOB #%d IS COMPLETE', job.id);
			}).on('failed', function(err) {
				console.log('JOB #%d FAILED', job.id);
			});

			// Essentially, I'm using an immediately invoked function, that takes a callback as a parameter
			// as a way to ensure I'll be setting req.lastJob at a time when that information is available.


			job.save(function(err) {

				// Check if an error occurred on save
				if(err) 
					console.log("There was a problem saving job with ID #%d.", job.id);

				cb(job);

			}); // saves the new job to the queue

		};

		next();
	})
	.post(function(req, res) { // Post for this specific route

		// Initialize some vars based on parsed body
		var url = req.body.url;
		var verb = req.body.method || "get";
		var params = extend({}, req.body); // Make a copy of the body object

		// Now we delete url and method from the params object so they won't be included in the params
		delete params.url;
		delete params.method;


		// Create is not returning a jobId properly. Not really surprising now that I looked again.
		// Need to think about how to get this jobId into the response without doing something awful in the global scope like I currently am.
		req.create(verb.toLowerCase(), url, params, function(lastJob) {

			// If user includes a query param f with value text, send a plain text response back to the client
			if(req.query.f === "text") {
				res.set('Content-Type', 'text/plain');
				var textResponse = "Job #" + lastJob.id + " has been queued.\n";
				textResponse += "Use GET /jobs/"+lastJob.id+" to check the status of your job.";
				res.send(textResponse);
			} else {
				res.set('Content-Type', 'text/html');
				var htmlResponse = "<h2>Job #" + lastJob.id + " has been queued.</h2>";
				htmlResponse += "<p>Use GET /jobs/"+lastJob.id+" to check its status (and retrieve results once available.)</p>";
				htmlResponse += "<p>You can also <a href=\"/jobs/"+lastJob.id+"\">click here</a> to check and see if the results are available.";
				res.send(htmlResponse);
			}

		});
	})
	.get(function(req, res) {
		// You can test making a post request with this:
		// http://localhost:3000/jobs?url=http://postcatcher.in/catchers/555821a7f902920300002f76&method=post&p=topic:tshirts+cool

		var url = req.query.url;
		if(!url)
			res.send("You must include a URL as a query parameter to add a job using a GET request");

		var verb = req.query.method || "get";

		// This function parses params in attached to req.query.p
		// p=key:value,key:value, as part of a larger string ?url=http://domain.com/&method=post&p=key:value,key:value
		req.createParams = function(str) {
			if(!str)
				return null; // If req.query.p was undefined, return null

			var obj = {};
			x = str.split(',');
			for(var i = 0; i < x.length; i++) {
				var split = x[i].split(":");
				if(split[0].trim() !== "method" && split[0].trim() !== "url") {
					obj[split[0].trim()] = split[1].trim();
				}
			}
			return obj;
		}
		
		// Build the params object
		var params = req.createParams(req.query.p);

		// Now let's create the job request
		req.create(verb.toLowerCase(), url, params, function(lastJob) {

			// If user includes a query param f with value text, send a plain text response back to the client
			if(req.query.f === "text") {
				res.set('Content-Type', 'text/plain');
				var textResponse = "Job #" + lastJob.id + " has been queued.\n";
				textResponse += "Use GET /jobs/"+lastJob.id+" to check the status of your job.";
				res.send(textResponse);
			} else {
				res.set('Content-Type', 'text/html');
				var htmlResponse = "<h2>Job #" + lastJob.id + " has been queued.</h2>";
				htmlResponse += "<p>Use GET /jobs/"+lastJob.id+" to check its status (and retrieve results once available.)</p>";
				htmlResponse += "<p>You can also <a href=\"/jobs/"+lastJob.id+"\">click here</a> to check and see if the results are available.";
				res.send(htmlResponse);
			}

		});

	});

// Set up the server on port 3000
app.listen(3000, function() {
	var msg = "* LISTENING ON PORT 3000 *";

	console.log(Array(msg.length+1).join("*"));
	console.log(msg);
	console.log(Array(msg.length+1).join("*"));
});




