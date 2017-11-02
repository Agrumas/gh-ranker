# GitHub project evaluator PoC

## Installation

1. Download node:
https://nodejs.org/en/download/

Script was tested with v6.11 but it should work with newer versions too.

2. Install dependencies:
````
npm install
````

## Configuration

1. Generate `Personal access token` at 
https://github.com/settings/tokens

2. Create a file named `token` and saved it there. Alternative way is to set it as env variable `TOKEN` or pass as parameter `--token`.

## Execution

````
node ./evaluator.js -q <query> -l <limit=20> -s <sort=updated> -o <order=desc>
````

Last fetched data is stored in `data_latest.json` you can load and rank the same dataset:

````
node ./evaluator.js -i data_latest
````
