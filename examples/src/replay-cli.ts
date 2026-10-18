import {domains,replay,type Domain} from './scenarios';
const domain=process.argv[2];if(!domains.includes(domain as Domain))throw new Error('Choose software, research or procurement');
console.log(JSON.stringify(replay(domain as Domain),null,2));
