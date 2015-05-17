# HTTP Request Job Queue

A simple API with 3 endpoints that allows a client to add HTTP requests to a worker queue.

## Getting set up

  1. Just clone this repository.
  2. Make sure you have a copy of **redis** installed and running.
  3. Run `npm install` to install the dependencies
  4. Run `node app.js` at a command prompt in bash, zsh, or another shell

Once the server is running you can create and access jobs using the following endpoints.

## Endpoints

###Create new Jobs with the Following Routes

####`GET /jobs`

**This endpoint is controlled using the query parameters:**
`url`: The url to make the request to (required)
`method`: The HTTP method to use to make the request (defaults to GET)
`p`: Add extra parameters to be part of the request.

**If you add parameters using `p`, they need to be in the following format:**
`p=key:value,key2:value2,key3:value3`

####`POST /jobs`

You can set the details of the request to be made using the POST body in application/x-www-form-urlencoded format.

Using CURL
```
curl -X POST http://localhost:3000/jobs --data "url=http://somedomain.com/&topic=sometopic&method=POST/GET"
```

#### Response:

Both of these endpoints will return a Job ID that can be used to retrieve the response data from the request once it is complete.

###Retrieve Existing Jobs

####`GET /jobs/:id`

This endpoint takes no parameters. Simply use the job ID sent back when you created the job in the first place. Like this:

With CURL:
`curl http://localhost:3000/jobs/18`

You can also make this request with a browser, by visiting the following URL:
`http://localhost:3000/jobs/18`