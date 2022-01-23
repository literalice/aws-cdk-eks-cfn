import { Construct } from 'constructs';
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export interface AwsCdkEksCfnProps {
  // Define construct properties here
}

export class AwsCdkEksCfn extends Construct {

  constructor(scope: Construct, id: string, props: AwsCdkEksCfnProps = {}) {
    super(scope, id);

    // Define construct contents here

    // example resource
    // const queue = new sqs.Queue(this, 'AwsCdkEksCfnQueue', {
    //   visibilityTimeout: cdk.Duration.seconds(300)
    // });
  }
}
