import { readUrl } from '../read';
import { TokenTracker } from '../../utils/token-tracker';

describe('readUrl', () => {
  it('should read and parse URL content)', async () => {
    const tokenTracker = new TokenTracker();
    const { response } = await readUrl('http://www.humanrights.ge/index.php?a=text&lang=eng&pid=19631', true, tokenTracker);
    expect(response).toHaveProperty('code');
    expect(response).toHaveProperty('status');
    expect(response.data).toHaveProperty('content');
    expect(response.data).toHaveProperty('title');
  }, 15000);

  it.skip('should handle invalid URLs)', async () => {
    await expect(readUrl('invalid-url')).rejects.toThrow();
  }, 15000);

  beforeEach(() => {
    jest.setTimeout(15000);
  });
});
