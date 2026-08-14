import { describe, expect, it } from 'vitest';
import { describeWdaErrorValue } from './iosXcuitestDriver';

describe('describeWdaErrorValue', () => {
  it('maps missing bundle ids to app not installed', () => {
    expect(describeWdaErrorValue({
      error: 'invalid argument',
      message: 'Application info provider (FBSApplicationLibrary) returned nil for "com.ss.iphone.ugc.Aweme"',
    })).toBe('app not installed (com.ss.iphone.ugc.Aweme)');
  });

  it('keeps a short fallback for other WDA errors', () => {
    expect(describeWdaErrorValue({
      error: 'unknown error',
      message: 'Error Domain=LSApplicationWorkspaceErrorDomain Code=115 "(null)"',
    })).toBe('unknown error: Error Domain=LSApplicationWorkspaceErrorDomain Code=115 "(null)"');
  });
});
