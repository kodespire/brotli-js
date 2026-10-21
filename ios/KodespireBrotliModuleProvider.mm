#import "KodespireBrotliModuleProvider.h"

#import "KodespireBrotliModule.h"

@implementation KodespireBrotliModuleProvider

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::KodespireBrotliModule>(params.jsInvoker);
}

@end
