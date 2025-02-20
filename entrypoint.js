const got = require('got')
const {ensureDir, writeFile} = require('fs-extra')
const {join, resolve} = require('path')
const Figma = require('figma-js')
const {FIGMA_TOKEN, FIGMA_FILE_URL} = process.env
const PQueue = require('p-queue')
const sanitize = require("sanitize-filename")

const options = {
  format: 'jpg',
  outputDir: './build/',
  scale: '1'
}

for(const arg of process.argv.slice(2)) {
  const [param, value] = arg.split('=')
  if(options[param]) {
    options[param] = value
  }
}

if(!FIGMA_TOKEN) {
  throw Error('Cannot find FIGMA_TOKEN in process!')
}

const client = Figma.Client({
  personalAccessToken: FIGMA_TOKEN
})

// Fail if there's no figma file key
let fileId = null
if (!fileId) {
  try {
    fileId = FIGMA_FILE_URL.match(/file\/([a-z0-9]+)\//i)[1]
  } catch (e) {
    throw Error('Cannot find FIGMA_FILE_URL key in process!')
  }
}

console.log(`Exporting ${FIGMA_FILE_URL} components`)
client.file(fileId)

  .then(({ data }) => {
    console.log('Processing response')
    const components = {}

    function check(c) {
      if (c.type === 'COMPONENT') {
        const {name, id} = c
        const {description = '', key} = data.components[c.id]
        const {width, height} = c.absoluteBoundingBox
        const filename = `${sanitize(name).toLowerCase()}.${options.format}`;

        components[id] = {
          name,
          filename,
          id,
          key,
          file: fileId,
          description,
          width,
          height
        }
      } else if (c.children) {
        // eslint-disable-next-line github/array-foreach
        c.children.forEach(check)
      }
    }

    data.document.children.forEach(check)
    if (Object.values(components).length === 0) {
      throw Error('No components found!')
    }
    console.log(`${Object.values(components).length} components found in the figma file`)
    return components
  })
  .then(components => {
    console.log('Getting export urls')
    const allComponentIds = Object.keys(components)
    console.log('The number of components: ', allComponentIds.length)
    console.log('The number of components with image: ', allComponentIds.filter(id => components[id].image).length)
    const getFileImages = chunkArray(allComponentIds).map(ids => {
      return client.fileImages(
        fileId,
        {
          ids,
          format: options.format,
          scale: options.scale
        }
      ).then(({data}) => {
        for(const id of Object.keys(data.images)) {
          components[id].image = data.images[id]
        }
        return components
      })
    })
    return Promise.all(getFileImages).then(() => components)
  })
  .then(components => {
    console.log('The number of components with image after request: ', Object.keys(components).filter(id => components[id].image).length)
    return ensureDir(join(options.outputDir))
      .then(() => writeFile(resolve(options.outputDir, 'data.json'), JSON.stringify(components), 'utf8'))
      .then(() => components)
  })
  .then(components => {
    const contentTypes = {
      'svg': 'image/svg+xml',
      'png': 'image/png',
      'jpg': 'image/jpeg'
    }
    return queueTasks(Object.values(components).map(component => () => {
      return got.get(component.image, {
        headers: {
          'Content-Type': contentTypes[options.format]
        },
        encoding: (options.format === 'svg' ? 'utf8' : null)
      })
      .then(response => {
        return ensureDir(join(options.outputDir, options.format))
          .then(() => writeFile(join(options.outputDir, options.format, component.filename), response.body, (options.format === 'svg' ? 'utf8' : 'binary')))
      })
    }))
  })
  .catch(error => {
    throw Error(`Error fetching components from Figma: ${error}`)
  })

function queueTasks(tasks, options) {
  const queue = new PQueue(Object.assign({concurrency: 3}, options))
  for (const task of tasks) {
    queue.add(task)
  }
  queue.start()
  return queue.onIdle()
}

function chunkArray(arr, chunkSize = 100) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += chunkSize) {
    chunks.push(arr.slice(i, i + chunkSize));
  }
  return chunks;
}
