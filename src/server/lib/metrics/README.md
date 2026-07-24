# Metrics Util

The `Metrics` class is a util class with a few functions to make adding lifecycle metrics clean and clear.

---

## API

### `new Metrics({options})`

**`{options}`** an object argument of **Metrics** options.

- `{alert_type: string}`: The type of log that is sent to Datadog
- `{branchName: string}`: The branch name of the repository
- `{namespace: string}`: The name of the associated metrics, in example `deploy`
- `{uuid: string}`: The unique identifier for each mini-cookie instance.
- `{repositoryName: string}`: The name of the repository
- `{source_type_name?: string}`: The source_type_name which is used for Datadog
- `{tags: Object}`: The tags that are sent to Datadog
- `{eventDetails: Object}`: The event details that are sent to Datadog
- `{disableMetrics: boolean}`: A flag to disable metrics

### `event(title, description)`

- `{title: string}`: The title of the event
- `{description: string}`: The description of the event
- `{tags: Object}`: Tags to add to the event
- `{options: Object}`: Options passed to the LifecycleMetrics method

### `increment(metric, tags)`

- `{metric: string}`: The name of the metric to increment
- `{tags: Object}`: Tags to add to the metric
- `{options: Object}`: Options passed to the LifecycleMetrics method

### `updateEventDetails(eventDetails)`

- `{eventDetails: Object}`: event details which are mapped to this metric instance's config object

### `updateConfigTags(tags)`

- `{tags: Object}`: tags which are mapped to this metric instance's config object

---

## Recipes

Every public function can be chained

```javascript
const meta = {
  branchName: 'test-branch',
  uuid: 'test-uuid',
  repositoryName: 'test-repo',
}
const metrics = new LifecycleMetrics('testing', meta)
metrics.increment('test1').increment('test2')
```

Transactions can be batched

```javascript
const meta = {
  branchName: 'test-branch',
  uuid: 'test-uuid',
  repositoryName: 'test-repo',
}
const metrics = new LifecycleMetrics('testing', meta)
metrics.transaction([{ name: "test1" }, { name: "test2"}], { title: 'test', description: 'a test' }, { testing: 'yup' })
```

Information is gathered and merged

```javascript
const meta = {
  branchName: 'test-branch',
  uuid: 'test-uuid',
  repositoryName: 'test-repo',
  tags: { foo: 'bar' }
}
const metrics = new LifecycleMetrics('testing', meta)
metrics.increment('a-test', { biz: 'baz' }); // => lifecycle.testing.a-test tags: { foo: 'bar', biz: 'baz' }
```

Force exact tags for a given public method

```javascript
const meta = {
  branchName: 'test-branch',
  uuid: 'test-uuid',
  repositoryName: 'test-repo',
  tags: { foo: 'bar' }
}
const metrics = new LifecycleMetrics('testing', meta)
metrics.increment('a-test', { biz: 'baz' }, { forceExactTags });  // => lifecycle.testing.a-test tags: { biz: 'baz' }
```

Everything can be configured!

---

[Back to root](../../../../readme.md)
