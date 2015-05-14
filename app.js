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

// Set up body parser for processing POSTs
app.use(bodyParser.urlencoded({extended: true}));

// Now set up a hash where we can store completed jobs
// Structure will be { jobId: jobResult }
var completedJobs = {};

/*
 * Using Kue:
 * So. it essentially appears that using Kue is fairly straightforward.
 * Basically, I can create a jobs cue by running jobs = kue.createQueue();
 * Then, that "jobs" variable will give me access to the ability to create new jobs (using jobs.create())
 * and to process those jobs in various ways using jobs.process, the event handler that is called when a new job is created.

 * jobs.process() takes
 * a string (that defines the type of job to actually process)
 * a callback function that takes two params:
 * 1) job - the job being processed
 * 2) a function done to be called when the work of the processing is done
 * - note: done can also be called as done(err) with some error value that defines that an error occurred.

 * This is interesting because at the time of job creation you can also set a few different event handlers. Namely:
 * job.on('complete', cb), job.on('failure', cb) and these behave the way you'd expect.
 * 
 * My thought is:
 * Can I use the cb in the "failure" event to pass through an error object in case a HTTP request fails?
 * So can I say job.on('failure', function(err) {}), and then somehow use that err inside the failure callback?

 * Also, to make this work, I'm going to have to be able to look up the status of a completed job using its ID.
 * This also essentially means that I'll have to be able to get the job ID at the time a job is created using the POST Endpoint
 * and send it back to the user in the response.
*/


// Create:
// verb: the HTTP verb to use for the request
// url: the URL for the API call
// params: An object with key:value pairs (optional for get, required for post)

var create = function(verb, url, params) {

	// Do some error checking
	if(verb === 'post' && !params)
		return "A post request must include a params object.";

	// So, we create a new job
	var job = jobs.create(verb, { url: url, params: params });

	// Now set some event handlers for success and failure
	job.on('complete', function() {
		console.log('JOB #%d IS COMPLETE', job.id);
	}).on('failed', function(err) {
		console.log('JOB #%d FAILED', job.id);
	})
	// .on('result', function(res) {
	// 	// res should now contain the result of the HTTP request
	// 	console.log("Results of a job were returned:", res);
	// });

	job.save(); // saves the new job to the queue

	// Now return the job id so we can send it back to the user
	// NOTE: Might need to use (and then parse) workerId instead as the job ids seem to reset on each launch of the server.
	return job.id;
}

/*
Sample Job Object:
{
	id : "3",
	type : "get",
	data :  { 
		url : "http : //www.google.com",
		params : { 
			first : "first",
			second : "third"
		}
	},
	priority : 0,
	progress : 0,
	state : "active",
	created_at : "1431591922074",
	promote_at : "1431591922074",
	updated_at : "1431591922075",
	started_at : 1431591922077,
	workerId : "kue : Sacagawea.local : 63454 : get : 1",
	attempts : {
		made : 0,
		remaining : 1,
		max : 1
	}
}

*/

// Set the event handler for HTTP request jobs using GET
jobs.process('get', function(job, done) {
	var r = request.get(job.data.url, job.data.params || null, function(err, resp, body) {
		// Now we'll decide what to do based on the results of the request
		if(err || resp.statusCode !== 200) {
			// All is not good in the hood, so end processing and throw the error returned by request
			return done(err);
		};

		// Because kue doesn't support passing results back natively, I'm creating a new event for my own use
		events.emit(job.id, "result", { responseBody: body });

		// Now attach the results to the job itself in Redis
		rdclient.hmset(['q:job:'+job.id, 'respBody', body], function(redisError, redisResult) {
			if(redisError) return done(redisError);
		})

		// Not sure if I was supposed to implement persistence now that I think about it, so I'm just
		// going to use a simple hash in JS for now to store the results of the HTTP requests

		// For some reason we are not making it all the way to here... hmmm...
		console.log("Debug here");
		completedJobs[job.id.toString()] = body;
		console.log(completedJobs);

		done(); // End processing now that we've attached everything (may want to remove this to give callbacks time to happen)
	});

});

// Now let's get to routes

// GET job by id
app.get('/jobs/:id', function(req, res) {
	var jobId = req.params.id;

	console.log(completedJobs);

	// Look up the job in the redis db
	rdclient.hget(['q:job:'+jobId, 'respBody'], function(redisError, redisResult) {
		if(redisError) {
			res.set('Content-Type', 'text/plain');
			res.send("Job " + jobId + " not yet complete.");
		} else {
			// Send back the result
			if(redisResult.indexOf("<!doctype") === -1) {
				res.set('Content-Type', 'application/json');
			} else {
				res.set('Content-Type', 'text/html');
			}
			res.send(redisResult);
		}
	});
});

app.post('/jobs', function(req, res) {
	var body = req.body;
	body.params = body.params || null;

	var jobId = create('get', body.url, body.params);

	res.set('Content-Type', 'text/plain');
	res.send("Job #" + jobId + " has been queued. Use POST /jobs/:id to check its status (and retrieve results once available.)");


});

app.listen(3000, function() {
	console.log("LISTENING ON PORT 3000");
});




