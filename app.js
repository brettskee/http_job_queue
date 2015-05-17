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
	app = express();

// To support new event emissions in Kue
var events = require('kue/lib/queue/events');

// Create the jobs queue
var jobs = kue.createQueue();

// We'll also want to make it easier to access the redis client that Kue creates
var rdclient = kue.Job.client;
global.lastJobId = 0; // Cheap workaround for the moment. And it doesn't work on the very first post request for some reason.

// Set up body parser for processing POSTs
app.use(bodyParser.urlencoded({extended: true}));

// Now set up a hash where we can store completed jobs
// Structure will be { jobId: jobResult }
app.use(function(req, res, next) {

	// Setting up some additional variables I think I'll need as middleware
	req.completedJobs = req.completedJobs || {};

	next();
});


// Now put my custom Kue functions into middleware
app.use(function(req, res, next) {

	// Helper functions
	req.helpers = {};

	// Helpers: encode ascii text in base64
	req.helpers.base64encode = function base64encode(str) {
		return new Buffer(str).toString('base64');
	}

	// Helpers: decode base64 text into ascii
	req.helpers.base64decode = function base64decode(b64) {
		return new Buffer(b64, 'base64').toString('ascii');
	}

	// Creating some functions to avoid some of the right drift in jobs.process
	req.makeGetRequest = function(job, done) {
		var r = request.get(job.data.url, function(err, resp, body) {
			// Now we'll decide what to do based on the results of the request
			if(err || resp.statusCode !== 200) {
				// All is not good in the hood, so end processing and throw the error returned by request
				return done(err);
			};

			// The request results should be back
			// Store the response in a local hash so that we can access the results synchronously.
			req.completedJobs[job.id] = req.helpers.base64encode(body); // base64encode the results to avoid problems with newlines etc.

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
	req.makePostRequest = function(job, done) {
		var r = request.get(job.data.url, job.data.params, function(err, resp, body) {
			// Now we'll decide what to do based on the results of the request
			if(err || resp.statusCode !== 200) {
				// All is not good in the hood, so end processing and throw the error returned by request
				return done(err);
			};

			// The request results should be back
			// Store the response in a local hash so that we can access the results synchronously.
			req.completedJobs[job.id] = req.helpers.base64encode(body); // base64encode the results to avoid problems with newlines etc.

			// Now attach the results to the job itself in Redis
			rdclient.hmset(['q:job:'+job.id, 'respBody', body, 'respContentType', resp.headers['content-type'] ], function(redisError, redisResult) {
				if(redisError) 
					return done(redisError); // end if an error occurred.

				// End processing now that we've stored the data in Redis
				return done(); 
			});
		});
	}

	// Set the event handlers for HTTP request jobs using GET and POST
	jobs.process('get', req.makeGetRequest);
	jobs.process('post', req.makePostRequest);


	// Create function:
	// verb: the HTTP verb to use for the request
	// url: the URL for the API call
	// params: An object with key:value pairs (optional for get, required for post)
	// cb: A callback to execute the response to the client

	req.create = function(verb, url, params, cb) {

		// Do some error checking to make sure all post requests include a params object
		if(verb === 'post' && !params)
			return "A post request must include a params object.";

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
			console.log("job.save() started.");
			console.log("this callback should only be triggered once the save has occurred and jobId #%d is available.", job.id);

			// Check if an error occurred on save
			if(err) 
				console.log("problem saving job with id", job.id);

			cb(job);

			// process.nextTick(function() { cb(job); });

			console.log("job.save() finished.");

		}); // saves the new job to the queue

	};

	next();

});

// GET job by id
app.get('/jobs/:id', function(req, res) {
	var jobId = req.params.id;

	// Look up the job in the redis db
	rdclient.hmget(['q:job:'+jobId, 'respBody', 'respContentType'], function(redisError, response) {
		if(redisError) {
			res.set('Content-Type', 'text/html');
			res.send("<h2>Job " + jobId + " not yet complete.</h2><p><a html=\"/jobs/"+jobId+"\">Click to Repeat Your Request</a></p>");
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
app.post('/jobs', function(req, res) {

	// Initialize some vars based on parsed body
	var body = req.body;
	body.params = body.params || null;
	var verb = body.method || "get";

	// Create is not returning a jobId properly. Not really surprising now that I looked again.
	// Need to think about how to get this jobId into the response without doing something awful in the global scope like I currently am.
	req.create(verb, body.url, body.params, function(lastJob) {
		console.log("job.save() callback has started running.");

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

		console.log("job.save() callback has finished running.");
	});
});

app.listen(3000, function() {
	console.log("LISTENING ON PORT 3000");
});




