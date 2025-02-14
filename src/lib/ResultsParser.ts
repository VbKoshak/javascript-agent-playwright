import {RerunConfig, zebrunnerConfig} from './ZebrunnerReporter';
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(ffmpegPath);
let UAParser = require('ua-parser-js');
let parser = new UAParser();

export type testResult = {
  suiteName: string;
  name: string;
  testId?: number;
  testRunId?: number;
  attachment?: {
    video: Record<string, string>[];
    files: Record<string, string>[];
    screenshots: Record<string, number>[];
  };
  browserCapabilities: browserCapabilities;
  endedAt: Date;
  reason: string;
  retry: number;
  startedAt: Date;
  status: 'FAILED' | 'PASSED' | 'SKIPPED' | 'ABORTED';
  tags: {
    key: string;
    value: string;
  }[];
  steps?: testStep[];
  maintainer: string;
  sessionId?: number;
};

export type testStep = {
  level: 'INFO' | 'ERROR';
  timestamp: string;
  message: string;
  testId?: number;
};

export type browserCapabilities = {
  ua: string;
  browser: {
    name: string;
    version: string;
    major: string;
  };
  engine: {
    name: string;
    version: string;
  };
  os: {
    name: string;
    version: string;
  };
  device: {
    vendor: string | undefined;
    model: string | undefined;
    type: string | undefined;
  };
  cpu: {
    architecture: string;
  };
};

export type testSuite = {
  testSuite: {
    title: string;
    tests: testResult[];
    testRunId?: number;
  };
};

export type testRun = {
  tests: testResult[];
  testRunId?: number;
  title: string;
  testRunName: string;
  build: string;
  environment: string;
};

export type testSummary = {
  build: string;
  environment: string;
  passed: number;
  failed: number;
  skipped: number;
  aborted: number;
  duration: number;
  failures: {
    zebResult: string;
    test: string;
    message: string;
  }[];
};

export default class ResultsParser {
  private _resultsData: any;
  private _result: testRun;
  private _build: string;
  private _environment: string;
  private _rerunConfig: RerunConfig;
  constructor(results, config: zebrunnerConfig, rerunConfig) {
    this._build = config?.reportingRunBuild ? config?.reportingRunBuild : '1.0 alpha(default)';
    this._environment = config?.reportingRunEnvironment ? config?.reportingRunEnvironment : '-';
    this._result = {
      tests: [],
      testRunId: 0,
      title: '',
      testRunName: config?.reportingRunDisplayName
        ? config?.reportingRunDisplayName
        : 'Default Suite',
      build: this._build,
      environment: this._environment,
    };
    this._resultsData = results;
    this._rerunConfig = rerunConfig;
  }

  public get build() {
    return this._build;
  }

  public get environment() {
    return this._environment;
  }

  async getParsedResults(): Promise<testRun> {
    return this._result;
  }

  getRunStartTime(): number {
    return new Date(this._result.tests[0].startedAt).getTime() - 1000;
  }

  async parse() {
    for (const project of this._resultsData.suites) {
      for (const testSuite of project.suites) {
        await this.parseTestSuite(testSuite);
      }
    }
  }

  async parseTestSuite(suite, suiteIndex = 0) {
    const launchInfo = suite.project();
    let testResults = [];
    if (suite.suites?.length > 0) {
      testResults = await this.parseTests(
        suite.parent.title ? `${suite.parent.title} > ${suite.title}` : suite.title,
        suite.tests,
        launchInfo
      );
      this.updateResults({
        tests: testResults,
      });
      await this.parseTestSuite(suite.suites[suiteIndex], suiteIndex++);
    } else {
      testResults = await this.parseTests(
        suite.parent.title ? `${suite.parent.title} > ${suite.title}` : suite.title,
        suite.tests,
        launchInfo
      );
      this.updateResults({
        tests: testResults,
      });
      return;
    }
  }

  updateResults(data) {
    if (data.tests.length > 0) {
      this._result.tests = this._result.tests.concat(data.tests);
    }
  }

  async parseTests(suiteName, tests, launchInfo) {
    const browserCapabilities = this.parseBrowserCapabilities(launchInfo);
    let testResults: testResult[] = [];
    for (const test of tests) {
      for (const result of test.results) {
        testResults.push({
          suiteName: suiteName,
          name: `${suiteName} > ${test.title}`,
          tags: this.getTestTags(test.title, test.tcmTestOptions),
          status: this.determineStatus(result.status),
          retry: result.retry,
          startedAt: new Date(result.startTime),
          endedAt: new Date(new Date(result.startTime).getTime() + result.duration),
          browserCapabilities: browserCapabilities,
          // testCase: `${result.location.file?}${result.location.line?}:${result.location.column?}`,
          reason: `${this.cleanseReason(result.error?.message)} \n ${this.cleanseReason(
            result.error?.stack
          )}`,
          attachment: this.processAttachment(result.attachments),
          steps: this.getTestSteps(result.steps),
          maintainer: test.maintainer || 'anonymous',
        });
      }
    }
    return testResults;
  }

  parseBrowserCapabilities(launchInfo) {
    parser.setUA(launchInfo.use.userAgent);
    return parser.getResult();
  }

  cleanseReason(rawReason) {
    return rawReason
      ? rawReason
          .replace(/\u001b\[2m/g, '')
          .replace(/\u001b\[22m/g, '')
          .replace(/\u001b\[31m/g, '')
          .replace(/\u001b\[39m/g, '')
          .replace(/\u001b\[32m/g, '')
          .replace(/\u001b\[27m/g, '')
          .replace(/\u001b\[7m/g, '')
      : '';
  }

  getTestTags(testTitle, tcmTestOptions) {
    let tags = testTitle.match(/@\w*/g) || [];

    if (tcmTestOptions) {
      tcmTestOptions.forEach((el) => {
        tags.push(el);
      });
    }

    if (tags.length !== 0) {
      return tags.map((c) => {
        if (typeof c === 'string') {
          return {key: 'tag', value: c.replace('@', '')};
        }
        if (typeof c === 'object') {
          return c;
        }
      });
    }
    return null;
  }

  processAttachment(attachment) {
    if (attachment) {
      let attachmentObj = {
        video: [],
        files: [],
        screenshots: [],
      };
      attachment.forEach(async (el) => {
        if (el.contentType === 'video/webm') {
          await this.convertVideo(el.path, 'mp4');
          attachmentObj.video.push({
            path: el.path.replace('.webm', '.mp4'),
            timestamp: Date.now(),
          });
        }
        if (el.contentType === 'application/zip') {
          attachmentObj.files.push({
            path: el.path,
            timestamp: Date.now(),
          });
        }
        if (el.contentType === 'image/png') {
          attachmentObj.screenshots.push({
            path: el.path,
            timestamp: Date.now(),
          });
        }
      });
      return attachmentObj;
    }
    return null;
  }

  async convertVideo(path, format) {
    try {
      const fileName = path.replace('.webm', '');
      const convertedFilePath = `${fileName}.${format}`;
      await ffmpeg(path).toFormat(format).outputOptions(['-vsync 2']).saveToFile(convertedFilePath);
    } catch (error) {
      console.log(error);
    }
  }

  determineStatus(status) {
    if (status === 'failed') return 'FAILED';
    else if (status === 'passed') return 'PASSED';
    else if (status === 'skipped') return 'SKIPPED';
    else return 'ABORTED';
  }

  getTestSteps(steps): testStep[] {
    let testSteps = [];
    for (const testStep of steps) {
      testSteps.push({
        timestamp: new Date(testStep.startTime).getTime(),
        message: testStep.error
          ? `${this.cleanseReason(testStep.error?.message)} \n ${this.cleanseReason(
              testStep.error?.stack
            )}`
          : testStep.title,
        level: testStep.error ? 'ERROR' : 'INFO',
      });
    }

    if (this._rerunConfig?.mode === 'RERUN') {
      testSteps.push({
        timestamp: new Date(steps[0].startTime).getTime() - 1,
        message: `RERUN START`,
        level: 'INFO',
      });
      testSteps.push({
        timestamp: new Date(steps[steps.length - 1].startTime).getTime() + 1,
        message: `RERUN END`,
        level: 'INFO',
      });
    }

    return testSteps;
  }
}
