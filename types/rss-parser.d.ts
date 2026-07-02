declare module 'rss-parser' {
  class Parser {
    constructor(options?: any);
    parseURL(feedUrl: string): Promise<any>;
  }

  export = Parser;
}
