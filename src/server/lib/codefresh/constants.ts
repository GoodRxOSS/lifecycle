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

import { TMP_PATH } from 'shared/config';

export const CODEFRESH_PATH = `${TMP_PATH}/codefresh`;

export const CF = {
  CHECKOUT: {
    PATH: `${TMP_PATH}/codefresh`,
    CHECKOUT_STAGE: 'Checkout',
    TYPE: 'git-clone',
    CHECKOUT_STEP_TITLE: 'Checkout repo',
  },
  BUILD: {
    STAGE: 'Build',
    TITLE: 'Build lifecycle image',
    TYPE: 'build',
    buildkit: true,
  },
};

export const CF_CHECKOUT_STEP = {
  stage: CF.CHECKOUT.CHECKOUT_STAGE,
  fail_fast: true,
  title: CF.CHECKOUT.CHECKOUT_STEP_TITLE,
};

export const CF_BUILD_STEP = {
  stage: CF.BUILD.STAGE,
  title: CF.BUILD.TITLE,
  type: CF.BUILD.TYPE,
  buildkit: true,
  buildx: true,
  when: {
    steps: [
      {
        name: 'Checkout',
        on: ['success'],
      },
    ],
  },
};

export const CF_AFTER_BUILD_STEP = {
  stage: 'PostBuild',
  type: 'codefresh-run:1.5.3',
  title: 'Invoke pipeline after build completes',
  when: {
    steps: [
      {
        name: 'Build',
        on: ['success'],
      },
    ],
  },
};
