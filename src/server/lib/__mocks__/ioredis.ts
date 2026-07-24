/**
 * Copyright 2025 GoodRx, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

class Redis {
  hget: jest.Mock;
  hmget: jest.Mock;
  hset: jest.Mock;
  expire: jest.Mock;
  hgetall: jest.Mock;
  duplicate: jest.Mock;
  setMaxListeners: jest.Mock;
  quit: jest.Mock;
  disconnect: jest.Mock;
  constructor() {
    this.hget = jest.fn().mockResolvedValue(null);
    this.hmget = jest.fn().mockResolvedValue([]);
    this.hset = jest.fn().mockResolvedValue(null);
    this.expire = jest.fn().mockResolvedValue(null);
    this.hgetall = jest.fn().mockResolvedValue({});
    this.duplicate = jest.fn().mockReturnValue(this);
    this.setMaxListeners = jest.fn();
    this.quit = jest.fn().mockResolvedValue(undefined);
    this.disconnect = jest.fn();
  }
}

export default Redis;
