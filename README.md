# Deadsimple

A local-first desktop API client for Windows. Send HTTP requests, inspect the responses, and keep your requests organised in collections, with no account and no cloud.

## What it does

- Build and send requests with params, headers, body, and auth (Bearer, Basic, API key)
- View responses as a JSON tree, a sortable/filterable table, or raw text, with a timing breakdown (DNS, TCP, TLS, download)
- Organise requests into collections with `{{variables}}` and switchable variable sets
- Import from cURL, Postman v2 collections, and OpenAPI 3.x / Swagger 2.0 specs; copy any request as cURL
- Cookie jar, proxy support, redirect and TLS settings, and request history

## Why

Most API clients have grown heavy: they want you to sign in, sync to their cloud, and keep your work in a format you can't easily read. Deadsimple does the one job, sending requests and reading responses, and stays out of the way.

Everything is stored as plain JSON files on your own machine (`%APPDATA%\Deadsimple`; see **Settings → Data folder**), so your collections are easy to read, diff, back up, or put in git.

## Download

Grab the latest `.exe` from the [Releases page](https://github.com/detib/deadsimpleapi/releases/latest):

- `deadsimpleapi.exe`: runs without installing
- `deadsimpleapi-setup.exe`: installer

The app isn't code-signed, so Windows SmartScreen may warn on first launch. Click **More info → Run anyway**.

## Build from source

Requires Node.js.

```sh
npm install
npm run dev     # run in development
npm run dist    # build installers into release/
```
