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

import { Knex } from 'knex';

export const timestamps = (builder: Knex.TableBuilder) => {
  builder.dateTime('createdAt');
  builder.dateTime('updatedAt');
  builder.dateTime('deletedAt');
};

interface RelateOptions {
  referentialAction?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION' | 'SET DEFAULT';
}

export const relate = (
  builder: Knex.TableBuilder,
  column: string,
  to: string,
  { referentialAction = 'CASCADE' }: RelateOptions = {}
) => {
  return builder.integer(column).unsigned().references(to).onDelete(referentialAction).onUpdate(referentialAction);
};
